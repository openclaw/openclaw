import type { SessionActorStorageBinding } from "../config/sessions/session-actor-storage-binding.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { getAsyncWorkSignal } from "../shared/async-work-scope.js";
import type { SessionCostUsageRollupRow } from "./session-cost-usage-cache.kernel.js";
import { publishSessionCostUsageUpdated } from "./session-cost-usage-events.js";
import { prepareUsageCostWorker, runUsageCostWorker } from "./session-cost-usage-worker-runtime.js";
import type { UsageCostPendingFile } from "./session-cost-usage-worker.types.js";

export async function refreshCostUsageCacheForAgent(params: {
  config?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  agentId: string;
  agentDir?: string;
  databasePath?: string;
  maxFiles?: number;
  onRemaining?: (files: UsageCostPendingFile[]) => void;
  storePath?: string;
  sessionFiles?: string[];
  startMs?: number;
  rebuildRows?: SessionCostUsageRollupRow[];
  sessionActor?: SessionActorStorageBinding;
  waitForRefresh?: boolean;
}): Promise<"refreshed" | "busy"> {
  const prepared = prepareUsageCostWorker(params);
  const agentId = normalizeAgentId(params.agentId);
  try {
    const operation = {
      kind: "refresh",
      maxFiles: params.maxFiles,
      sessionFiles: params.sessionFiles,
      startMs: params.startMs,
      rebuildRows: params.rebuildRows,
    } satisfies Parameters<typeof runUsageCostWorker>[1];
    const result = await runUsageCostWorker(prepared, operation, params.waitForRefresh);
    if (result.kind === "busy") {
      return "busy";
    }
    if (result.kind !== "refresh") {
      throw new Error("Invalid usage refresh worker result");
    }
    if (result.changed) {
      publishSessionCostUsageUpdated(agentId);
    }
    if (result.remainingFiles?.length) {
      params.onRemaining?.(result.remainingFiles);
    }
    return "refreshed";
  } catch (error) {
    if (!getAsyncWorkSignal()?.aborted) {
      publishSessionCostUsageUpdated(agentId, true);
    }
    throw error;
  }
}
