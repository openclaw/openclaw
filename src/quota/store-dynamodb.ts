import type { QuotaStore } from "./types.js";

export type DynamoDbQuotaStoreConfig = {
  tableName: string;
  region?: string;
  endpoint?: string;
};

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Lazy-load a module by name, bypassing TypeScript module resolution.
 * The packages (`@aws-sdk/client-dynamodb`, `@aws-sdk/lib-dynamodb`) must be
 * installed at runtime but are NOT required at build time.
 */
async function lazyImport(name: string): Promise<any> {
  return import(/* webpackIgnore: true */ name);
}

export async function createDynamoDbQuotaStore(
  config: DynamoDbQuotaStoreConfig,
): Promise<QuotaStore> {
  const dynamodb: any = await lazyImport("@aws-sdk/client-dynamodb");
  const docLib: any = await lazyImport("@aws-sdk/lib-dynamodb");

  const client = new dynamodb.DynamoDBClient({
    region: config.region,
    ...(config.endpoint ? { endpoint: config.endpoint } : {}),
  });
  const docClient = docLib.DynamoDBDocumentClient.from(client);
  const tableName = config.tableName;

  return {
    async getUsage(customerId: string) {
      const result = await docClient.send(
        new docLib.GetCommand({
          TableName: tableName,
          Key: { customerId },
        }),
      );
      if (!result.Item) {
        return null;
      }
      return {
        tokensUsed: (result.Item.tokensUsed as number) ?? 0,
        plan: (result.Item.plan as string) ?? "free",
      };
    },

    async incrementUsage(customerId: string, tokens: number) {
      await docClient.send(
        new docLib.UpdateCommand({
          TableName: tableName,
          Key: { customerId },
          UpdateExpression: "ADD tokensUsed :tokens",
          ExpressionAttributeValues: { ":tokens": tokens },
        }),
      );
    },

    async setCustomer(customerId: string, plan: string) {
      await docClient.send(
        new docLib.UpdateCommand({
          TableName: tableName,
          Key: { customerId },
          UpdateExpression: "SET #plan = :plan",
          ExpressionAttributeNames: { "#plan": "plan" },
          ExpressionAttributeValues: { ":plan": plan },
        }),
      );
    },

    async close() {
      client.destroy();
    },
  };
}
