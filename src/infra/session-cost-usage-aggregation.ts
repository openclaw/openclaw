import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { getAsyncWorkSignal } from "../shared/async-work-scope.js";
import type { SessionCostUsageRollupRow } from "./session-cost-usage-cache.kernel.js";
import { publishSessionCostUsageUpdated } from "./session-cost-usage-events.js";
import {
  withUsageCostIncognitoScope,
  type UsageCostIncognitoBinding,
} from "./session-cost-usage-incognito.js";
import {
  prepareUsageCostWorker,
  runUsageCostWorker,
  type PreparedUsageCostWorker,
} from "./session-cost-usage-worker-runtime.js";

export async function refreshCostUsageCacheForAgent(params: {
  config?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  agentId: string;
  agentDir?: string;
  databasePath?: string;
  maxFiles?: number;
  sessionsDir?: string;
  storePath?: string;
  sessionFiles?: string[];
  startMs?: number;
  rebuildRows?: SessionCostUsageRollupRow[];
  incognito?: UsageCostIncognitoBinding;
}): Promise<"refreshed" | "busy"> {
  const prepared = prepareUsageCostWorker(params);
  return withUsageCostIncognitoScope(
    prepared.incognito,
    (incognito) => refreshCapturedCostUsageCacheForAgent({ ...params, incognito }, prepared),
    true,
  );
}

async function refreshCapturedCostUsageCacheForAgent(
  params: Parameters<typeof refreshCostUsageCacheForAgent>[0],
  prepared?: PreparedUsageCostWorker,
): Promise<"refreshed" | "busy"> {
  const agentId = normalizeAgentId(params.agentId);
  try {
    const result = await runUsageCostWorker(
      prepared ?? prepareUsageCostWorker(params),
      {
        kind: "refresh",
        maxFiles: params.maxFiles,
        sessionsDir: params.sessionsDir,
        sessionFiles: params.sessionFiles,
        startMs: params.startMs,
        rebuildRows: params.rebuildRows,
      },
      params.incognito,
    );
    if (result.kind === "busy") {
      return "busy";
    }
    if (result.kind !== "refresh") {
      throw new Error("Invalid usage refresh worker result");
    }
    if (result.changed) {
      params.incognito?.actor.assertCurrent();
      params.incognito?.authority.assertCurrent();
      publishSessionCostUsageUpdated(agentId);
    }
    return "refreshed";
  } catch (error) {
    if (!getAsyncWorkSignal()?.aborted) {
      try {
        params.incognito?.actor.assertCurrent();
        params.incognito?.authority.assertCurrent();
        publishSessionCostUsageUpdated(agentId, true);
      } catch {
        // Retired actors cannot publish failure facts for their successors.
      }
    }
    throw error;
  }
}
