
const waitOn = require('wait-on');
const express = require('express');
const { graphqlHTTP } = require('express-graphql');
const { introspectSchema, wrapSchema, RenameTypes, RenameRootFields, TransformQuery } = require('@graphql-tools/wrap');
const { stitchSchemas } = require('@graphql-tools/stitch');
const { delegateToSchema } = require('@graphql-tools/delegate');
const { batchDelegateToSchema } = require('@graphql-tools/batch-delegate');
const { Kind } = require('graphql');



const makeRemoteExecutor = require('./lib/make_remote_executor');
const localSchema = require('./services/local/schema');

async function makeGatewaySchema() {
  // Make remote executors:

  const covidExec = makeRemoteExecutor('https://helloworld-capsc6nslq-uc.a.run.app/graphql');
  const vaccineExec = makeRemoteExecutor('https://vaccination-capsc6nslq-uc.a.run.app/graphql');
  const adminContext = { authHeader: 'Bearer my-app-to-app-token' };

  const vaccineSchema = wrapSchema({
    schema: await introspectSchema(vaccineExec, adminContext),
    executor: vaccineExec, // this field is extremely important, this makes schema executable
  });

  return stitchSchemas({
    subschemas: [
      {
        schema: vaccineSchema,
        executor: vaccineExec, // unnecessary as vaccine schema already executatble
      },
      {
        schema: await introspectSchema(covidExec, adminContext),
        executor: covidExec,
      },
      {
        schema: localSchema
      }
    ],
    // 5. Add additional schema directly into the gateway proxy layer.
    // Under the hood, `stitchSchemas` is a wrapper for `makeExecutableSchema`,
    // and accepts all of its same options. This allows extra type definitions
    // and resolvers to be added directly into the top-level gateway proxy schema.
    typeDefs: `
    type Query {
      heartbeat: String!
    }
    type StateMeta {
      hey: FipsCodeState!
      batch: FipsCodeStatesConnection!
    }`,
    resolvers: {
      Query: {
        heartbeat: () => 'OK',
      },
      StateMeta: {
        hey: async (parent, args, context, info) => {
          // perform the subquery to the schema
          const res = await delegateToSchema({
            schema: vaccineSchema,
            operation: 'query',
            fieldName: 'fipsCodeStateByStateFipsCode', // this is the query to make, WTF it is "fieldname"
            args: {
              stateFipsCode: parent.stateFipsCode,
            },
            context,
            info,
          });
          return res;
        },

        batch: async (parent, args, context, info) => {
          // the flow of batching is as follows: 
          //  1. which field/key you can perform the batch query on. (stateFipsCode)
          //  2. collects all the keys into an array, and ask argsFromKeys to form
          //     a proper argument for the query to perform the batch/mass query
          //     in our case, the postgraphile has the filtering-plugin installed so 
          //     that it actually the "in" operator, the default postgraphile condition 
          //     only has the equality operator which cannot do an "or" operation.
          //  3. Batch operation expects an array as result
          return await batchDelegateToSchema({
            schema: vaccineSchema,
            operation: "query",
            fieldName: "allFipsCodeStates", // ctu
            key: parent.stateFipsCode,
            argsFromKeys: (stateFipsCode) => {
              return (
                {
                  filter: {
                    stateFipsCode: {
                      in: stateFipsCode,
                    }
                  }
                }
              );
            },
            // IMPORTANT: don't add args this will mess things up. 
            // args: {
            //   filter: {
            //     stateFipsCode: {
            //       in: ['06', '01']
            //     }
            //   }
            // },
            // IMPORTANT: we need this to respect the order of the keys
            // the underlying query may return results in random order
            // batch will use the natural order, so we need to order it here.
            valuesFromResults: (results, keys) => {
              // IMPORTANT: this relies on stateFipesCode to exist on the query 
              // so that it can be matched from the key.
              const newresult = keys.map(key => results.find(element => {
                if (element.edges) {
                  if (!element.edges[0].node.stateFipsCode) throw new Error("Need stateFipsCode in Query for edges")
                  return element.edges[0].node.stateFipsCode == key;
                }
                if (element.nodes) {
                  if (!element.nodes[0].stateFipsCode) throw new Error("Need stateFipsCode in Query for nodes")
                  return element.nodes[0].stateFipsCode == key;
                }
                throw new Error("Query needs nodes or edges")
              }));
              return newresult;

            },
            context,
            info,
            transforms: [
              new TransformQuery({
                path: ['allFipsCodeStates'], // very necessary
                queryTransformer: (subtree) => {
                  // no need to tranform the query. but this must exist
                  return subtree;
                },
                resultTransformer: (result) => {
                  // console.log(JSON.stringify(result, 0, 2));
                  // this transformation is to the mapping results into a form 
                  // that batchDelegateSchema expects. basically a special for 
                  // integrating Postgraphile with remote schema stitching. 
                  // They expect an array (list.map function must exist)
                  // Even a bit more complicated when you can either select either edges or nodes
                  const edges = result?.edges?.map(a => ({ edges: [a] }));
                  const nodes = result?.nodes?.map(a => ({ nodes: [a] }));
                  if (nodes && edges) {
                    const combined = nodes.map((n, index) => ({
                      nodes: n.nodes,
                      ...edges[index]
                    }));
                    return combined;
                  }
                  return nodes ? nodes : edges;
                },
              }),
            ],

          });
        }

      }
    }
  });
}

// this is cool.
// waitOn({ resources: ['tcp:4001', 'tcp:4002'] }, async () => {
waitOn({ resources: [] }, async () => {
  const schema = await makeGatewaySchema();
  const app = express();
  app.use('/graphql', graphqlHTTP((req) => ({
    schema,
    context: { authHeader: req.headers.authorization },
    graphiql: true
  })));
  app.listen(4000, () => console.log('gateway running at http://localhost:4000/graphql'));
});

/* The query to test is
query hey {
  allStateMetas(filter: {stateFipsCode: {in: ["06", "02", "01", "01", "31", "36"]}}, orderBy: POPULATION_DESC) {
    edges {
      node {
        stateFipsCode
        stateAbbr
        stateName
        population
        batch {
          edges {
            node {
              statePostalAbbreviation
              stateName
              stateFipsCode
            }
          }
          nodes {
            statePostalAbbreviation
            stateName
            stateFipsCode
          }
        }
      }
    }
  }
}
*/