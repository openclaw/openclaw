import { normalizeAgentId, resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import { sweepCronRunSessions } from "../session-reaper.js";
import { listLocallyOwnedCronRunReceiptIds } from "../store/run-receipt-store.js";
import type { InterruptedStartupRun } from "../store/run-recovery.types.js";
import type { CronJob } from "../types.js";
import { enrollForeignReceipt } from "./foreign-receipt-monitor.js";
import { locked } from "./locked.js";
import { emitInterruptedCronRun } from "./run-recovery-events.js";
import { recoverCronRunProposals } from "./run-recovery.js";
import type { CronServiceState } from "./state.js";
import { ensureLoaded, runPostPersistCronNotifications } from "./store.js";

/** Reconcile execution owners and expired sessions before the worker considers due jobs. */
export async function runCronSchedulerMaintenance(state: CronServiceState): Promise<void> {
  const generation = state.lifecycleGeneration;
  try {
    await locked(state, async () => {
      await ensureLoaded(state);
      if (state.stopped || state.lifecycleGeneration !== generation) {
        return;
      }
      const locallyOwned = new Set(listLocallyOwnedCronRunReceiptIds());
      const proposals = (state.store?.jobs ?? [])
        .filter(
          (job) =>
            job.state.queuedAtMs !== undefined ||
            (job.state.runningAtMs !== undefined &&
              (!job.state.runningReceiptId || !locallyOwned.has(job.state.runningReceiptId))),
        )
        .map((job) => ({
          jobId: job.id,
          queuedAtMs: job.state.queuedAtMs,
          runningAtMs: job.state.runningAtMs,
        }));
      let repaired = false;
      const interruptedRuns: InterruptedStartupRun[] = [];
      try {
        await recoverCronRunProposals(state, proposals, {
          isCurrent: () => !state.stopped && state.lifecycleGeneration === generation,
          async onRecovery(_proposal, result) {
            if (result.kind === "repaired") {
              repaired = true;
              await runPostPersistCronNotifications(state, result.notifications);
              if (result.interrupted) {
                interruptedRuns.push(result.interrupted);
              }
            } else if (result.receipt && result.receipt.ownerPid !== process.pid) {
              enrollForeignReceipt(state, result.receipt);
            }
          },
        });
      } finally {
        if (repaired) {
          await ensureLoaded(state, { forceReload: true });
        }
        for (const interrupted of interruptedRuns) {
          await emitInterruptedCronRun(state, interrupted);
        }
      }
    });
  } finally {
    try {
      if (
        state.lifecycleGeneration === generation &&
        (state.deps.resolveSessionStorePath || state.deps.sessionStorePath)
      ) {
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
            state.deps.log.warn(
              { err: String(err), storePath },
              "cron: session reaper sweep failed",
            );
          }
        }
      }
    } catch (err) {
      state.deps.log.warn({ err: String(err) }, "cron: session reaper preparation failed");
    }
  }
}
