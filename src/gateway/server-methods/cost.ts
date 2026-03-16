import { loadConfig } from "../../config/config.js";
import { seedPricingData } from "../../infra/cost-db-seed.js";
import {
  deleteLedgerItem,
  generateCostId,
  initCostDb,
  listLedgerItems,
  upsertLedgerItem,
  type BillingCycle,
  type LedgerCostType,
  type LedgerItem,
  type LedgerStatus,
} from "../../infra/cost-db.js";
import type { CostUsageSummary, SessionModelUsage } from "../../infra/session-cost-usage.js";
import {
  discoverAllSessions,
  loadCostUsageSummary,
  loadSessionCostSummary,
} from "../../infra/session-cost-usage.js";
import { ErrorCodes, errorShape } from "../protocol/index.js";
import { listAgentsForGateway, loadCombinedSessionStoreForGateway } from "../session-utils.js";
import type { GatewayRequestHandlers } from "./types.js";

const DAY_MS = 24 * 60 * 60 * 1000;

type DateRange = { startMs: number; endMs: number };

const parseDateToMs = (raw: unknown): number | undefined => {
  if (typeof raw !== "string" || !raw.trim()) {
    return undefined;
  }
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw.trim());
  if (!match) {
    return undefined;
  }
  const year = Number(match[1]);
  const monthIndex = Number(match[2]) - 1;
  const day = Number(match[3]);
  const ms = Date.UTC(year, monthIndex, day);
  return Number.isNaN(ms) ? undefined : ms;
};

const parseDateRange = (params: {
  startDate?: unknown;
  endDate?: unknown;
  days?: unknown;
}): DateRange => {
  const now = new Date();
  const todayStartMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const todayEndMs = todayStartMs + DAY_MS - 1;

  const startMs = parseDateToMs(params.startDate);
  const endMs = parseDateToMs(params.endDate);

  if (startMs !== undefined && endMs !== undefined) {
    return { startMs, endMs: endMs + DAY_MS - 1 };
  }

  const days =
    typeof params.days === "number" && Number.isFinite(params.days) ? Math.floor(params.days) : 30;
  const clampedDays = Math.max(1, days);
  const start = todayStartMs - (clampedDays - 1) * DAY_MS;
  return { startMs: start, endMs: todayEndMs };
};

// Cost summary response type for UI
export type CostSummaryResponse = {
  updatedAt: number;
  range: { startMs: number; endMs: number };
  totals: {
    total: number;
    llm: number;
    fixed: number;
    oneOff: number;
    usage: number;
  };
  bySourceType: {
    llm: CostUsageSummary["totals"];
    fixed: number;
    oneOff: number;
    usage: number;
  };
};

// Cost timeseries response type for UI
export type CostTimeseriesResponse = {
  updatedAt: number;
  range: { startMs: number; endMs: number };
  series: Array<{
    date: string;
    llm: number;
    fixed: number;
    oneOff: number;
    usage: number;
    total: number;
  }>;
};

// Model cost breakdown response type
export type ModelCostBreakdownResponse = {
  updatedAt: number;
  range: { startMs: number; endMs: number };
  byProvider: Array<{
    provider: string;
    totalCost: number;
    totalTokens: number;
    models: Array<{
      model: string;
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens: number;
      cacheWriteTokens: number;
      totalTokens: number;
      totalCost: number;
      callCount: number;
    }>;
  }>;
};

// Top sessions response type
export type TopSessionsResponse = {
  updatedAt: number;
  range: { startMs: number; endMs: number };
  sessions: Array<{
    key: string;
    sessionId: string;
    label?: string;
    agentId?: string;
    totalCost: number;
    totalTokens: number;
    modelUsage?: SessionModelUsage[];
    firstActivity?: number;
    lastActivity?: number;
  }>;
};

// Ledger item response type
export type LedgerItemResponse = Omit<LedgerItem, "tags"> & {
  tags: string[];
};

// Convert database ledger item to response format
function ledgerItemToResponse(item: LedgerItem): LedgerItemResponse {
  let tags: string[] = [];
  if (item.tags) {
    try {
      tags = JSON.parse(item.tags);
    } catch {
      tags = [];
    }
  }
  return { ...item, tags };
}

// Calculate amortized fixed costs for a date range
function calculateAmortizedFixedCosts(
  ledgerItems: LedgerItem[],
  startMs: number,
  endMs: number,
): {
  totalFixed: number;
  totalUsage: number;
  totalOneOff: number;
  byDay: Map<string, { fixed: number; oneOff: number; usage: number }>;
} {
  const result = {
    totalFixed: 0,
    totalUsage: 0,
    totalOneOff: 0,
    byDay: new Map<string, { fixed: number; oneOff: number; usage: number }>(),
  };

  const fixedItems = ledgerItems.filter(
    (item) => item.costType === "fixed" && item.status === "active",
  );
  const oneOffItems = ledgerItems.filter(
    (item) => item.costType === "one_off" && item.status === "active",
  );
  const usageItems = ledgerItems.filter(
    (item) => item.costType === "usage" && item.status === "active",
  );

  // Process fixed items - amortize daily
  for (const item of fixedItems) {
    // Skip if item hasn't started yet
    if (item.effectiveStart > endMs) {
      continue;
    }
    // Skip if item has ended before our range
    if (item.effectiveEnd && item.effectiveEnd < startMs) {
      continue;
    }

    // Calculate daily cost based on billing cycle
    let dailyCost: number;
    if (item.billingCycle === "monthly") {
      dailyCost = item.amount / 30; // Approximate month
    } else if (item.billingCycle === "annual") {
      dailyCost = item.amount / 365;
    } else {
      // No billing cycle - treat as one-time (shouldn't happen for fixed)
      dailyCost = item.amount;
    }

    // Apply to each day in the range where the item is active
    const itemStart = Math.max(item.effectiveStart, startMs);
    const itemEnd = item.effectiveEnd ? Math.min(item.effectiveEnd, endMs) : endMs;

    let currentDay = itemStart;
    while (currentDay <= itemEnd) {
      const dayKey = new Date(currentDay).toISOString().slice(0, 10);
      const existing = result.byDay.get(dayKey) ?? { fixed: 0, oneOff: 0, usage: 0 };
      existing.fixed += dailyCost;
      result.byDay.set(dayKey, existing);
      result.totalFixed += dailyCost;
      currentDay += DAY_MS;
    }
  }

  // Process one-off items - add on the day they occurred
  for (const item of oneOffItems) {
    if (item.effectiveStart < startMs || item.effectiveStart > endMs) {
      continue;
    }

    const dayKey = new Date(item.effectiveStart).toISOString().slice(0, 10);
    const existing = result.byDay.get(dayKey) ?? { fixed: 0, oneOff: 0, usage: 0 };
    existing.oneOff += item.amount;
    result.byDay.set(dayKey, existing);
    result.totalOneOff += item.amount;
  }

  // Process usage items - for now just add to totals
  // In Phase 2, this could be linked to actual usage metrics
  for (const item of usageItems) {
    if (item.effectiveStart > endMs) {
      continue;
    }
    if (item.effectiveEnd && item.effectiveEnd < startMs) {
      continue;
    }
    // Usage-based costs would need actual usage data to compute
    // For now, we just track that these items exist
  }

  return result;
}

// Ensure cost database is initialized with pricing data
let dbInitialized = false;
function ensureCostDbInitialized(): void {
  if (dbInitialized) {
    return;
  }
  try {
    const db = initCostDb();
    seedPricingData(db);
    dbInitialized = true;
  } catch (err) {
    // Log error but don't fail - cost features will work without DB
    console.error("Failed to initialize cost database:", err);
  }
}

export const costHandlers: GatewayRequestHandlers = {
  "cost.summary": async ({ respond, params }) => {
    ensureCostDbInitialized();
    const config = loadConfig();
    const { startMs, endMs } = parseDateRange({
      startDate: params?.startDate,
      endDate: params?.endDate,
      days: params?.days,
    });

    // Load LLM costs from session transcripts
    const llmSummary = await loadCostUsageSummary({ startMs, endMs, config });

    // Load ledger items for fixed/one-off costs
    let ledgerCosts = { totalFixed: 0, totalUsage: 0, totalOneOff: 0 };
    try {
      const db = initCostDb();
      const items = listLedgerItems(db);
      ledgerCosts = calculateAmortizedFixedCosts(items, startMs, endMs);
    } catch {
      // Cost DB may not be available
    }

    const response: CostSummaryResponse = {
      updatedAt: Date.now(),
      range: { startMs, endMs },
      totals: {
        total:
          llmSummary.totals.totalCost +
          ledgerCosts.totalFixed +
          ledgerCosts.totalOneOff +
          ledgerCosts.totalUsage,
        llm: llmSummary.totals.totalCost,
        fixed: ledgerCosts.totalFixed,
        oneOff: ledgerCosts.totalOneOff,
        usage: ledgerCosts.totalUsage,
      },
      bySourceType: {
        llm: llmSummary.totals,
        fixed: ledgerCosts.totalFixed,
        oneOff: ledgerCosts.totalOneOff,
        usage: ledgerCosts.totalUsage,
      },
    };

    respond(true, response);
  },

  "cost.timeseries": async ({ respond, params }) => {
    ensureCostDbInitialized();
    const config = loadConfig();
    const { startMs, endMs } = parseDateRange({
      startDate: params?.startDate,
      endDate: params?.endDate,
      days: params?.days,
    });

    // Load LLM costs from session transcripts
    const llmSummary = await loadCostUsageSummary({ startMs, endMs, config });

    // Load ledger items for fixed/one-off costs
    let ledgerByDay = new Map<string, { fixed: number; oneOff: number; usage: number }>();
    try {
      const db = initCostDb();
      const items = listLedgerItems(db);
      const ledgerCosts = calculateAmortizedFixedCosts(items, startMs, endMs);
      ledgerByDay = ledgerCosts.byDay;
    } catch {
      // Cost DB may not be available
    }

    // Build series with all days in range
    const series: CostTimeseriesResponse["series"] = [];
    let currentDay = startMs;
    while (currentDay <= endMs) {
      const dayKey = new Date(currentDay).toISOString().slice(0, 10);
      const llmDaily = llmSummary.daily.find((d) => d.date === dayKey);
      const ledgerDaily = ledgerByDay.get(dayKey) ?? { fixed: 0, oneOff: 0, usage: 0 };

      const llmCost = llmDaily?.totalCost ?? 0;
      series.push({
        date: dayKey,
        llm: llmCost,
        fixed: ledgerDaily.fixed,
        oneOff: ledgerDaily.oneOff,
        usage: ledgerDaily.usage,
        total: llmCost + ledgerDaily.fixed + ledgerDaily.oneOff + ledgerDaily.usage,
      });
      currentDay += DAY_MS;
    }

    const response: CostTimeseriesResponse = {
      updatedAt: Date.now(),
      range: { startMs, endMs },
      series,
    };

    respond(true, response);
  },

  "cost.byModel": async ({ respond, params }) => {
    const config = loadConfig();
    const { startMs, endMs } = parseDateRange({
      startDate: params?.startDate,
      endDate: params?.endDate,
      days: params?.days,
    });

    // Discover all sessions in range
    const agents = listAgentsForGateway(config).agents;
    const allSessions = (
      await Promise.all(
        agents.map(async (agent) => {
          const sessions = await discoverAllSessions({
            agentId: agent.id,
            startMs,
            endMs,
          });
          return sessions.map((s) => ({ ...s, agentId: agent.id }));
        }),
      )
    ).flat();

    // Aggregate model usage across all sessions
    const modelMap = new Map<
      string,
      {
        provider: string;
        model: string;
        inputTokens: number;
        outputTokens: number;
        cacheReadTokens: number;
        cacheWriteTokens: number;
        totalTokens: number;
        totalCost: number;
        callCount: number;
      }
    >();

    for (const session of allSessions) {
      const summary = await loadSessionCostSummary({
        sessionId: session.sessionId,
        sessionFile: session.sessionFile,
        config,
        agentId: session.agentId,
        startMs,
        endMs,
      });

      if (!summary?.modelUsage) {
        continue;
      }

      for (const usage of summary.modelUsage) {
        const key = `${usage.provider ?? "unknown"}::${usage.model ?? "unknown"}`;
        const existing = modelMap.get(key) ?? {
          provider: usage.provider ?? "unknown",
          model: usage.model ?? "unknown",
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          totalTokens: 0,
          totalCost: 0,
          callCount: 0,
        };

        existing.inputTokens += usage.totals.input;
        existing.outputTokens += usage.totals.output;
        existing.cacheReadTokens += usage.totals.cacheRead;
        existing.cacheWriteTokens += usage.totals.cacheWrite;
        existing.totalTokens += usage.totals.totalTokens;
        existing.totalCost += usage.totals.totalCost;
        existing.callCount += usage.count;
        modelMap.set(key, existing);
      }
    }

    // Group by provider
    const providerMap = new Map<string, ModelCostBreakdownResponse["byProvider"][0]>();
    for (const model of modelMap.values()) {
      const existing = providerMap.get(model.provider) ?? {
        provider: model.provider,
        totalCost: 0,
        totalTokens: 0,
        models: [],
      };
      existing.totalCost += model.totalCost;
      existing.totalTokens += model.totalTokens;
      existing.models.push(model);
      providerMap.set(model.provider, existing);
    }

    // Sort providers and models by cost
    const byProvider = Array.from(providerMap.values())
      .toSorted((a, b) => b.totalCost - a.totalCost)
      .map((p) => ({
        ...p,
        models: p.models.toSorted((a, b) => b.totalCost - a.totalCost),
      }));

    const response: ModelCostBreakdownResponse = {
      updatedAt: Date.now(),
      range: { startMs, endMs },
      byProvider,
    };

    respond(true, response);
  },

  "cost.topSessions": async ({ respond, params }) => {
    const config = loadConfig();
    const { startMs, endMs } = parseDateRange({
      startDate: params?.startDate,
      endDate: params?.endDate,
      days: params?.days,
    });
    const limit =
      typeof params?.limit === "number" && Number.isFinite(params.limit)
        ? Math.max(1, Math.min(100, params.limit))
        : 20;

    // Load session store for labels
    const { store } = loadCombinedSessionStoreForGateway(config);
    const storeBySessionId = new Map<string, { key: string; label?: string }>();
    for (const [key, entry] of Object.entries(store)) {
      if (entry?.sessionId) {
        storeBySessionId.set(entry.sessionId, { key, label: entry.label });
      }
    }

    // Discover all sessions in range
    const agents = listAgentsForGateway(config).agents;
    const allSessions = (
      await Promise.all(
        agents.map(async (agent) => {
          const sessions = await discoverAllSessions({
            agentId: agent.id,
            startMs,
            endMs,
          });
          return sessions.map((s) => ({ ...s, agentId: agent.id }));
        }),
      )
    ).flat();

    // Load cost summary for each session
    const sessionCosts: TopSessionsResponse["sessions"] = [];
    for (const session of allSessions) {
      const summary = await loadSessionCostSummary({
        sessionId: session.sessionId,
        sessionFile: session.sessionFile,
        config,
        agentId: session.agentId,
        startMs,
        endMs,
      });

      if (!summary || summary.totalCost === 0) {
        continue;
      }

      const storeEntry = storeBySessionId.get(session.sessionId);
      sessionCosts.push({
        key: storeEntry?.key ?? `agent:${session.agentId}:${session.sessionId}`,
        sessionId: session.sessionId,
        label: storeEntry?.label,
        agentId: session.agentId,
        totalCost: summary.totalCost,
        totalTokens: summary.totalTokens,
        modelUsage: summary.modelUsage,
        firstActivity: summary.firstActivity,
        lastActivity: summary.lastActivity,
      });
    }

    // Sort by cost descending and limit
    const sortedSessions = sessionCosts
      .toSorted((a, b) => b.totalCost - a.totalCost)
      .slice(0, limit);

    const response: TopSessionsResponse = {
      updatedAt: Date.now(),
      range: { startMs, endMs },
      sessions: sortedSessions,
    };

    respond(true, response);
  },

  "cost.ledger.list": async ({ respond, params }) => {
    ensureCostDbInitialized();
    try {
      const db = initCostDb();
      const costType =
        typeof params?.costType === "string" ? (params.costType as LedgerCostType) : undefined;
      const status =
        typeof params?.status === "string" ? (params.status as LedgerStatus) : undefined;
      const includeDeleted = params?.includeDeleted === true;
      const limit = typeof params?.limit === "number" ? params.limit : undefined;
      const offset = typeof params?.offset === "number" ? params.offset : undefined;

      const items = listLedgerItems(db, { costType, status, includeDeleted, limit, offset });
      const response = items.map(ledgerItemToResponse);

      respond(true, { items: response });
    } catch (err) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, `Failed to list ledger items: ${String(err)}`),
      );
    }
  },

  "cost.ledger.upsert": async ({ respond, params }) => {
    ensureCostDbInitialized();

    // Validate required fields
    const name = typeof params?.name === "string" ? params.name.trim() : "";
    if (!name) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "name is required"));
      return;
    }

    const costType =
      typeof params?.costType === "string" ? (params.costType as LedgerCostType) : undefined;
    if (!costType || !["fixed", "usage", "one_off"].includes(costType)) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "costType must be 'fixed', 'usage', or 'one_off'"),
      );
      return;
    }

    const amount = typeof params?.amount === "number" ? params.amount : undefined;
    if (amount === undefined || !Number.isFinite(amount) || amount < 0) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "amount must be a non-negative number"),
      );
      return;
    }

    const effectiveStart =
      typeof params?.effectiveStart === "number" ? params.effectiveStart : Date.now();

    try {
      const db = initCostDb();
      const id = typeof params?.id === "string" ? params.id : generateCostId();

      const item: Omit<LedgerItem, "createdAt" | "updatedAt"> = {
        id,
        name,
        vendor: typeof params?.vendor === "string" ? params.vendor : null,
        category: typeof params?.category === "string" ? params.category : null,
        costType,
        billingCycle:
          typeof params?.billingCycle === "string" ? (params.billingCycle as BillingCycle) : null,
        amount,
        metricUnit: typeof params?.metricUnit === "string" ? params.metricUnit : null,
        unitPrice: typeof params?.unitPrice === "number" ? params.unitPrice : null,
        effectiveStart,
        effectiveEnd: typeof params?.effectiveEnd === "number" ? params.effectiveEnd : null,
        notes: typeof params?.notes === "string" ? params.notes : null,
        tags: Array.isArray(params?.tags) ? JSON.stringify(params.tags) : null,
        status:
          typeof params?.status === "string" && ["active", "inactive"].includes(params.status)
            ? (params.status as LedgerStatus)
            : "active",
        deletedAt: null,
      };

      upsertLedgerItem(db, item);

      respond(true, { id });
    } catch (err) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, `Failed to upsert ledger item: ${String(err)}`),
      );
    }
  },

  "cost.ledger.delete": async ({ respond, params }) => {
    ensureCostDbInitialized();

    const id = typeof params?.id === "string" ? params.id : undefined;
    if (!id) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "id is required"));
      return;
    }

    try {
      const db = initCostDb();
      const deleted = deleteLedgerItem(db, id);

      if (!deleted) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "Ledger item not found"));
        return;
      }

      respond(true, { id });
    } catch (err) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, `Failed to delete ledger item: ${String(err)}`),
      );
    }
  },

  "cost.export": async ({ respond, params }) => {
    const config = loadConfig();
    const { startMs, endMs } = parseDateRange({
      startDate: params?.startDate,
      endDate: params?.endDate,
      days: params?.days,
    });
    const format = typeof params?.format === "string" && params.format === "json" ? "json" : "csv";

    // Load all cost data
    const llmSummary = await loadCostUsageSummary({ startMs, endMs, config });

    let ledgerItems: LedgerItem[] = [];
    let ledgerCosts = {
      totalFixed: 0,
      totalUsage: 0,
      totalOneOff: 0,
      byDay: new Map<string, { fixed: number; oneOff: number; usage: number }>(),
    };
    try {
      const db = initCostDb();
      ledgerItems = listLedgerItems(db);
      ledgerCosts = calculateAmortizedFixedCosts(ledgerItems, startMs, endMs);
    } catch {
      // Cost DB may not be available
    }

    if (format === "json") {
      respond(true, {
        range: { startMs, endMs },
        llm: llmSummary,
        ledger: {
          items: ledgerItems.map(ledgerItemToResponse),
          totals: {
            fixed: ledgerCosts.totalFixed,
            oneOff: ledgerCosts.totalOneOff,
            usage: ledgerCosts.totalUsage,
          },
        },
        totals: {
          total: llmSummary.totals.totalCost + ledgerCosts.totalFixed + ledgerCosts.totalOneOff,
          llm: llmSummary.totals.totalCost,
          fixed: ledgerCosts.totalFixed,
          oneOff: ledgerCosts.totalOneOff,
          usage: ledgerCosts.totalUsage,
        },
      });
      return;
    }

    // Build CSV
    const lines: string[] = [];
    lines.push("Date,LLM Cost,Fixed Cost,One-off Cost,Usage Cost,Total Cost");

    let currentDay = startMs;
    while (currentDay <= endMs) {
      const dayKey = new Date(currentDay).toISOString().slice(0, 10);
      const llmDaily = llmSummary.daily.find((d) => d.date === dayKey);
      const ledgerDaily = ledgerCosts.byDay.get(dayKey) ?? { fixed: 0, oneOff: 0, usage: 0 };

      const llmCost = llmDaily?.totalCost ?? 0;
      const total = llmCost + ledgerDaily.fixed + ledgerDaily.oneOff + ledgerDaily.usage;
      lines.push(
        `${dayKey},${llmCost.toFixed(4)},${ledgerDaily.fixed.toFixed(4)},${ledgerDaily.oneOff.toFixed(4)},${ledgerDaily.usage.toFixed(4)},${total.toFixed(4)}`,
      );
      currentDay += DAY_MS;
    }

    // Add totals row
    const grandTotal =
      llmSummary.totals.totalCost +
      ledgerCosts.totalFixed +
      ledgerCosts.totalOneOff +
      ledgerCosts.totalUsage;
    lines.push(
      `TOTAL,${llmSummary.totals.totalCost.toFixed(4)},${ledgerCosts.totalFixed.toFixed(4)},${ledgerCosts.totalOneOff.toFixed(4)},${ledgerCosts.totalUsage.toFixed(4)},${grandTotal.toFixed(4)}`,
    );

    respond(true, { csv: lines.join("\n") });
  },
};
