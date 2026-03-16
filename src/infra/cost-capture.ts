import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  computeCostFromMetric,
  getModelPricing,
  initCostDb,
  insertCostEvent,
  type CostMetric,
} from "./cost-db.js";

const log = createSubsystemLogger("cost-capture");

export type CostCaptureParams = {
  runId: string;
  sessionId: string;
  provider: string;
  model: string;
  agentId?: string;
  channelId?: string;
  usage?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    total?: number;
  };
  // Direct cost if already computed (from API response)
  cost?: {
    total?: number;
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
  };
};

let dbInitialized = false;
let dbAvailable = true;

function tryInitDb(): boolean {
  if (!dbAvailable) {
    return false;
  }
  if (dbInitialized) {
    return true;
  }
  try {
    initCostDb();
    dbInitialized = true;
    return true;
  } catch (err) {
    log.debug(`Cost database not available: ${String(err)}`);
    dbAvailable = false;
    return false;
  }
}

/**
 * Capture LLM cost event after a model call completes.
 * This is called asynchronously (fire-and-forget) to avoid blocking the agent.
 */
export async function captureLlmCost(params: CostCaptureParams): Promise<void> {
  try {
    // Skip if no usage data
    if (!params.usage) {
      return;
    }

    const { input, output, cacheRead, cacheWrite } = params.usage;
    if (!input && !output && !cacheRead && !cacheWrite) {
      return;
    }

    // Try to initialize database
    if (!tryInitDb()) {
      return;
    }

    const db = initCostDb();
    const timestamp = Date.now();

    // Compute cost - use direct cost if provided, otherwise look up pricing
    let costUsd: number;
    if (params.cost?.total !== undefined && params.cost.total > 0) {
      costUsd = params.cost.total;
    } else {
      // Look up pricing for this model
      const pricing = getModelPricing(db, params.provider, params.model, timestamp);
      if (!pricing) {
        // No pricing data available - skip capturing
        log.debug(`No pricing data for ${params.provider}/${params.model}`);
        return;
      }

      const metric: CostMetric = {
        input: input ?? 0,
        output: output ?? 0,
        cacheRead: cacheRead ?? 0,
        cacheWrite: cacheWrite ?? 0,
      };
      costUsd = computeCostFromMetric(metric, pricing);
    }

    // Insert cost event
    insertCostEvent(db, {
      timestamp,
      sourceType: "llm",
      service: params.provider,
      resource: params.model,
      metric: JSON.stringify({
        input: input ?? 0,
        output: output ?? 0,
        cacheRead: cacheRead ?? 0,
        cacheWrite: cacheWrite ?? 0,
        total: params.usage.total ?? 0,
      }),
      costUsd,
      category: "llm",
      sessionId: params.sessionId,
      runId: params.runId,
      agentId: params.agentId ?? null,
      channelId: params.channelId ?? null,
      metadata: null,
    });
  } catch (err) {
    // Don't let cost capture failures affect the agent
    log.debug(`Failed to capture LLM cost: ${String(err)}`);
  }
}

/**
 * Capture a fixed cost event (e.g., subscription charge).
 */
export async function captureFixedCost(params: {
  name: string;
  vendor: string;
  amount: number;
  category?: string;
  agentId?: string;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  try {
    if (!tryInitDb()) {
      return;
    }

    const db = initCostDb();
    const timestamp = Date.now();

    insertCostEvent(db, {
      timestamp,
      sourceType: "fixed",
      service: params.vendor,
      resource: params.name,
      metric: JSON.stringify({}),
      costUsd: params.amount,
      category: params.category ?? "fixed",
      sessionId: null,
      runId: null,
      agentId: params.agentId ?? null,
      channelId: null,
      metadata: params.metadata ? JSON.stringify(params.metadata) : null,
    });
  } catch (err) {
    log.debug(`Failed to capture fixed cost: ${String(err)}`);
  }
}

/**
 * Capture a one-off cost event.
 */
export async function captureOneOffCost(params: {
  name: string;
  vendor: string;
  amount: number;
  category?: string;
  sessionId?: string;
  agentId?: string;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  try {
    if (!tryInitDb()) {
      return;
    }

    const db = initCostDb();
    const timestamp = Date.now();

    insertCostEvent(db, {
      timestamp,
      sourceType: "one_off",
      service: params.vendor,
      resource: params.name,
      metric: JSON.stringify({}),
      costUsd: params.amount,
      category: params.category ?? "one_off",
      sessionId: params.sessionId ?? null,
      runId: null,
      agentId: params.agentId ?? null,
      channelId: null,
      metadata: params.metadata ? JSON.stringify(params.metadata) : null,
    });
  } catch (err) {
    log.debug(`Failed to capture one-off cost: ${String(err)}`);
  }
}
