import type { QuotaStore } from "./types.js";

let cachedStore: QuotaStore | null = null;

type QuotaStorageConfig = {
  quota?: {
    enabled?: boolean;
    storage?: {
      backend?: "dynamodb" | "redis";
      dynamodb?: { tableName: string; region?: string; endpoint?: string };
      redis?: { url?: string; keyPrefix?: string };
    };
  };
};

export async function getQuotaStore(config: QuotaStorageConfig): Promise<QuotaStore | null> {
  if (!config.quota?.enabled) {
    return null;
  }
  if (cachedStore) {
    return cachedStore;
  }

  const backend = config.quota.storage?.backend;
  if (backend === "dynamodb") {
    const dynCfg = config.quota.storage?.dynamodb;
    if (!dynCfg?.tableName) {
      throw new Error("quota.storage.dynamodb.tableName is required");
    }
    const { createDynamoDbQuotaStore } = await import("./store-dynamodb.js");
    cachedStore = await createDynamoDbQuotaStore(dynCfg);
    return cachedStore;
  }

  if (backend === "redis") {
    const redisCfg = config.quota.storage?.redis;
    const { createRedisQuotaStore } = await import("./store-redis.js");
    cachedStore = await createRedisQuotaStore(redisCfg ?? {});
    return cachedStore;
  }

  throw new Error(`Unknown quota storage backend: ${backend}`);
}

/** Reset the cached store (useful for testing). */
export function resetQuotaStore(): void {
  cachedStore = null;
}
