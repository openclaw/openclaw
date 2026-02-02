import type { ProviderUsageSnapshot } from "../../infra/provider-usage.types.js";
import type { CostUsageSummary } from "../../infra/session-cost-usage.js";
import type { GatewayRequestHandlers } from "./types.js";
import { loadConfig } from "../../config/config.js";
import { loadProviderUsageSummary } from "../../infra/provider-usage.js";
import { loadCostUsageSummary } from "../../infra/session-cost-usage.js";
import {
  getTokenUsageSummaries,
  getManusUsageSummary,
  recordManusTask,
  setSubscriptionTier,
  setMonthlyBudget,
  type SubscriptionTier,
} from "../../infra/token-usage-tracker.js";
import { ErrorCodes, errorShape } from "../protocol/index.js";

// Initialize tracker settings from config env vars
function initTrackerFromConfig(): void {
  const config = loadConfig();
  const env = config.env ?? {};

  // Set subscription tier from ANTHROPIC_SUBSCRIPTION_TIER
  const tier = env.ANTHROPIC_SUBSCRIPTION_TIER as string | undefined;
  if (tier && ["free", "pro", "max_5x", "max_20x", "api"].includes(tier)) {
    setSubscriptionTier(tier as SubscriptionTier);
  }

  // Set monthly budget from ANTHROPIC_MONTHLY_BUDGET_USD
  const budgetStr = env.ANTHROPIC_MONTHLY_BUDGET_USD as string | undefined;
  if (budgetStr) {
    const budget = Number(budgetStr);
    if (Number.isFinite(budget) && budget > 0) {
      setMonthlyBudget(budget);
    }
  }
}

// Initialize on module load
initTrackerFromConfig();

const COST_USAGE_CACHE_TTL_MS = 30_000;

type CostUsageCacheEntry = {
  summary?: CostUsageSummary;
  updatedAt?: number;
  inFlight?: Promise<CostUsageSummary>;
};

const costUsageCache = new Map<number, CostUsageCacheEntry>();

const parseDays = (raw: unknown): number => {
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return Math.floor(raw);
  }
  if (typeof raw === "string" && raw.trim() !== "") {
    const parsed = Number(raw);
    if (Number.isFinite(parsed)) {
      return Math.floor(parsed);
    }
  }
  return 30;
};

async function loadCostUsageSummaryCached(params: {
  days: number;
  config: ReturnType<typeof loadConfig>;
}): Promise<CostUsageSummary> {
  const days = Math.max(1, params.days);
  const now = Date.now();
  const cached = costUsageCache.get(days);
  if (cached?.summary && cached.updatedAt && now - cached.updatedAt < COST_USAGE_CACHE_TTL_MS) {
    return cached.summary;
  }

  if (cached?.inFlight) {
    if (cached.summary) {
      return cached.summary;
    }
    return await cached.inFlight;
  }

  const entry: CostUsageCacheEntry = cached ?? {};
  const inFlight = loadCostUsageSummary({ days, config: params.config })
    .then((summary) => {
      costUsageCache.set(days, { summary, updatedAt: Date.now() });
      return summary;
    })
    .catch((err) => {
      if (entry.summary) {
        return entry.summary;
      }
      throw err;
    })
    .finally(() => {
      const current = costUsageCache.get(days);
      if (current?.inFlight === inFlight) {
        current.inFlight = undefined;
        costUsageCache.set(days, current);
      }
    });

  entry.inFlight = inFlight;
  costUsageCache.set(days, entry);

  if (entry.summary) {
    return entry.summary;
  }
  return await inFlight;
}

export const usageHandlers: GatewayRequestHandlers = {
  "usage.status": async ({ respond }) => {
    const summary = await loadProviderUsageSummary();
    const tokenUsage = getTokenUsageSummaries();
    const manusUsage = getManusUsageSummary();
    respond(true, { ...summary, tokenUsage, manusUsage }, undefined);
  },
  "usage.cost": async ({ respond, params }) => {
    const config = loadConfig();
    const days = parseDays(params?.days);
    const summary = await loadCostUsageSummaryCached({ days, config });
    respond(true, summary, undefined);
  },
  "usage.manus.track": async ({ respond, params }) => {
    // Track a Manus task completion
    // Params: { taskId: string, credits: number }
    const taskId = typeof params?.taskId === "string" ? params.taskId : undefined;
    const credits = typeof params?.credits === "number" ? params.credits : undefined;

    if (!taskId || credits === undefined) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "Missing required params: taskId, credits"),
      );
      return;
    }

    recordManusTask(taskId, credits);
    const manusUsage = getManusUsageSummary();
    respond(true, { recorded: true, manusUsage }, undefined);
  },
};
