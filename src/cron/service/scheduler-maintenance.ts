import { normalizeAgentId, resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import { sweepCronRunSessions } from "../session-reaper.js";
import type { CronJob } from "../types.js";
import type { CronServiceState } from "./state.js";
import { ensureLoaded } from "./store.js";

/** Reap expired sessions independently of worker-owned run recovery. */
export async function runCronSchedulerMaintenance(state: CronServiceState): Promise<void> {
  const generation = state.lifecycleGeneration;
  try {
    if (
      state.lifecycleGeneration === generation &&
      (state.deps.resolveSessionStorePath || state.deps.sessionStorePath)
    ) {
      if (!state.store) {
        try {
          await ensureLoaded(state);
        } catch (err) {
          // Known session owners still need cleanup when cron inventory is unavailable.
          state.deps.log.warn({ err: String(err) }, "cron: session reaper inventory unavailable");
        }
      }
      const configuredDefaultAgentId = (
        state.deps.resolveDefaultAgentId?.() ?? state.deps.defaultAgentId
      )?.trim();
      const defaultAgentId = configuredDefaultAgentId
        ? normalizeAgentId(configuredDefaultAgentId)
        : undefined;
      const reaperAgentIds = new Set(
        ((await state.deps.resolveSessionStoreAgentIds?.()) ?? []).map(normalizeAgentId),
      );
      const resolveJobAgentId = (job: CronJob): string | undefined => {
        if (typeof job.agentId === "string" && job.agentId.trim()) {
          return normalizeAgentId(job.agentId);
        }
        try {
          return resolveAgentIdFromSessionKey(job.sessionKey, defaultAgentId);
        } catch {
          // Legacy ownerless rows need a configured default; other stores can still be swept.
          return undefined;
        }
      };
      for (const job of state.store?.jobs ?? []) {
        const agentId = resolveJobAgentId(job);
        if (agentId) {
          reaperAgentIds.add(agentId);
        }
      }
      if (defaultAgentId) {
        reaperAgentIds.add(defaultAgentId);
      }
      const nowMs = state.deps.nowMs();
      for (const agentId of reaperAgentIds) {
        const storePath = state.deps.resolveSessionStorePath
          ? state.deps.resolveSessionStorePath(agentId)
          : state.deps.sessionStorePath;
        if (!storePath) {
          continue;
        }
        try {
          await sweepCronRunSessions({
            agentId,
            cronConfig: state.deps.cronConfig,
            sessionStorePath: storePath,
            isAgentAvailable: state.deps.isAgentAvailable,
            nowMs,
            log: state.deps.log,
          });
        } catch (err) {
          state.deps.log.warn({ err: String(err), storePath }, "cron: session reaper sweep failed");
        }
      }
    }
  } catch (err) {
    state.deps.log.warn({ err: String(err) }, "cron: session reaper preparation failed");
  }
}
