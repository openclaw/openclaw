import type { SessionActorStorageBinding } from "../config/sessions/session-actor-storage-binding.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { getAsyncWorkSignal } from "../shared/async-work-scope.js";
import type { SessionCostUsageRollupRow } from "./session-cost-usage-cache.kernel.js";
import { publishSessionCostUsageUpdated } from "./session-cost-usage-events.js";
import {
  withUsageCostIncognitoScope,
  type UsageCostIncognitoBinding,
} from "./session-cost-usage-incognito.js";
import { prepareUsageCostWorker, runUsageCostWorker } from "./session-cost-usage-worker-runtime.js";

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
  sessionActor?: SessionActorStorageBinding;
}): Promise<"refreshed" | "busy"> {
  const prepared = prepareUsageCostWorker(params);
  return withUsageCostIncognitoScope<"refreshed" | "busy">(
    prepared.incognito,
    async (incognito) => {
      const scoped = { ...params, incognito };
      const agentId = normalizeAgentId(scoped.agentId);
      try {
        const result = await runUsageCostWorker(
          prepared,
          {
            kind: "refresh",
            maxFiles: scoped.maxFiles,
            sessionsDir: scoped.sessionsDir,
            sessionFiles: scoped.sessionFiles,
            startMs: scoped.startMs,
            rebuildRows: scoped.rebuildRows,
          },
          scoped.incognito,
        );
        if (result.kind === "busy") {
          return "busy";
        }
        if (result.kind !== "refresh") {
          throw new Error("Invalid usage refresh worker result");
        }
        if (result.changed) {
          scoped.incognito?.actor.assertCurrent();
          scoped.incognito?.authority.assertCurrent();
          publishSessionCostUsageUpdated(agentId);
        }
        return "refreshed";
      } catch (error) {
        if (!getAsyncWorkSignal()?.aborted) {
          try {
            scoped.incognito?.actor.assertCurrent();
            scoped.incognito?.authority.assertCurrent();
            publishSessionCostUsageUpdated(agentId, true);
          } catch {
            // Retired actors cannot publish failure facts for their successors.
          }
        }
        throw error;
      }
    },
    true,
  );
}
