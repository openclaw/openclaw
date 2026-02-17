import type { QuotaStatus } from "./types.js";
import { getQuotaStore } from "./store.js";

type QuotaConfig = {
  quota?: {
    enabled?: boolean;
    plans?: Record<string, { tokenLimit: number; label?: string }>;
    defaultPlan?: string;
    storage?: {
      backend?: "dynamodb" | "redis";
      dynamodb?: { tableName: string; region?: string; endpoint?: string };
      redis?: { url?: string; keyPrefix?: string };
    };
  };
};

export async function checkQuota(
  customerId: string,
  config: QuotaConfig,
): Promise<QuotaStatus | null> {
  const store = await getQuotaStore(config);
  if (!store) {
    return null;
  }

  const usage = await store.getUsage(customerId);
  const plan = usage?.plan ?? config.quota?.defaultPlan ?? "free";
  const planConfig = config.quota?.plans?.[plan];
  if (!planConfig) {
    return null;
  }

  const tokensUsed = usage?.tokensUsed ?? 0;
  const tokenLimit = planConfig.tokenLimit;
  const tokensRemaining = Math.max(0, tokenLimit - tokensUsed);

  return {
    customerId,
    plan,
    tokenLimit,
    tokensUsed,
    tokensRemaining,
    exceeded: tokensUsed >= tokenLimit,
  };
}

export async function deductQuota(
  customerId: string,
  tokens: number,
  config: QuotaConfig,
): Promise<void> {
  const store = await getQuotaStore(config);
  if (!store) {
    return;
  }
  await store.incrementUsage(customerId, tokens);
}
