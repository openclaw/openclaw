import { resolveAgentDir } from "../agents/agent-scope-config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { getAsyncWorkSignal } from "../shared/async-work-scope.js";
import { resolveOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.js";
import type { SessionCostUsageRollupRow } from "./session-cost-usage-cache.kernel.js";
import { publishSessionCostUsageUpdated } from "./session-cost-usage-events.js";
import { prepareUsageCostWorker, runUsageCostWorker } from "./session-cost-usage-worker-runtime.js";

export function resolveUsageCostCacheDatabasePath(agentId: string): string {
  return resolveOpenClawAgentSqlitePath({ agentId: normalizeAgentId(agentId) });
}

export function resolveUsageCostAgentDir(
  config: OpenClawConfig | undefined,
  agentId: string,
): string {
  return resolveAgentDir(config ?? {}, agentId);
}

export async function refreshCostUsageCacheForAgent(params: {
  config?: OpenClawConfig;
  agentId: string;
  agentDir?: string;
  databasePath?: string;
  maxFiles?: number;
  sessionsDir?: string;
  storePath?: string;
  sessionFiles?: string[];
  startMs?: number;
  rebuildRows?: SessionCostUsageRollupRow[];
}): Promise<"refreshed" | "busy"> {
  const agentId = normalizeAgentId(params.agentId);
  try {
    const prepared = prepareUsageCostWorker(params);
    const result = await runUsageCostWorker(prepared, {
      kind: "refresh",
      maxFiles: params.maxFiles,
      sessionsDir: params.sessionsDir,
      sessionFiles: params.sessionFiles,
      startMs: params.startMs,
      rebuildRows: params.rebuildRows,
    });
    if (result.kind === "busy") {
      return "busy";
    }
    if (result.kind !== "refresh") {
      throw new Error("Invalid usage refresh worker result");
    }
    if (result.changed) {
      publishSessionCostUsageUpdated(agentId);
    }
    return "refreshed";
  } catch (error) {
    if (!getAsyncWorkSignal()?.aborted) {
      publishSessionCostUsageUpdated(agentId, true);
    }
    throw error;
  }
}
