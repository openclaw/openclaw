import type { QuotaStore } from "./types.js";

export type RedisQuotaStoreConfig = {
  url?: string;
  keyPrefix?: string;
};

/* eslint-disable @typescript-eslint/no-explicit-any */

async function lazyImport(name: string): Promise<any> {
  return import(/* webpackIgnore: true */ name);
}

export async function createRedisQuotaStore(config: RedisQuotaStoreConfig): Promise<QuotaStore> {
  const ioredis: any = await lazyImport("ioredis");
  const Redis = ioredis.default ?? ioredis;

  const redis = config.url ? new Redis(config.url) : new Redis();
  const prefix = config.keyPrefix ?? "openclaw:quota";

  function key(customerId: string) {
    return `${prefix}:customer:${customerId}`;
  }

  return {
    async getUsage(customerId: string) {
      const data = await redis.hgetall(key(customerId));
      if (!data || Object.keys(data).length === 0) {
        return null;
      }
      return {
        tokensUsed: parseInt(data.tokensUsed ?? "0", 10),
        plan: data.plan ?? "free",
      };
    },

    async incrementUsage(customerId: string, tokens: number) {
      await redis.hincrby(key(customerId), "tokensUsed", tokens);
    },

    async setCustomer(customerId: string, plan: string) {
      await redis.hset(key(customerId), "plan", plan);
    },

    async close() {
      redis.disconnect();
    },
  };
}
