/**
 * Recover deferred sessions_manage actions that were persisted before a gateway restart.
 *
 * When sessions_manage schedules a deferred compact or reset, it writes pendingAction
 * to the session store and sets up an in-memory callback via waitForEmbeddedPiRunEnd().
 * If the gateway restarts, the callback is lost but the pendingAction persists.
 *
 * This module scans session stores on startup and:
 * - Clears stale pendingAction entries (older than MAX_AGE_MS)
 * - Executes recent pendingAction entries (compact or reset)
 *
 * Called from server-startup.ts after the gateway is ready.
 */

import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../agents/agent-scope.js";
import { compactEmbeddedPiSession } from "../agents/pi-embedded-runner/compact.js";
import {
  isEmbeddedPiRunActive,
  waitForEmbeddedPiRunEnd,
} from "../agents/pi-embedded-runner/runs.js";
import { loadConfig } from "../config/config.js";
import { updateSessionStore } from "../config/sessions.js";
import { resolveSessionFilePath, resolveSessionFilePathOptions } from "../config/sessions/paths.js";
import { resolveAgentIdFromSessionKey } from "../routing/session-key.js";
import { performGatewaySessionReset } from "./session-reset-service.js";
import {
  loadCombinedSessionStoreForGateway,
  resolveGatewaySessionStoreTarget,
} from "./session-utils.js";

/** Discard pendingAction entries older than 6 hours (likely stale from a crash).
 *  Matches the 6-hour waiter timeout so actions that time out waiting for a
 *  run to drain aren't immediately expired as stale on the next restart. */
const MAX_AGE_MS = 6 * 60 * 60 * 1000;

export async function recoverPendingActions(params: {
  log: { info: (msg: string) => void; warn: (msg: string) => void };
  /** Timestamp when this gateway lifecycle started. Used to distinguish
   *  markers from the current lifecycle (live waiters) vs previous lifecycles
   *  (crash leftovers). Must be set by the caller — not derived from process
   *  uptime, which doesn't account for in-process SIGUSR1 restarts. */
  gatewayBootMs: number;
}): Promise<void> {
  const { log, gatewayBootMs } = params;
  const cfg = loadConfig();

  try {
    const combined = loadCombinedSessionStoreForGateway(cfg);
    let found = 0;
    let recovered = 0;
    let cleared = 0;
    const failedEntries: Array<{ key: string; type: "compact" | "reset"; scheduledAt: number }> =
      [];

    for (const [key, entry] of Object.entries(combined.store)) {
      if (!entry?.pendingAction) {
        continue;
      }
      found++;

      const { type, scheduledAt, instructions, reason: persistedReason } = entry.pendingAction;
      const ageMs = Date.now() - (scheduledAt ?? 0);

      // Scheduled after this process started — belongs to a live deferred waiter, not a crash leftover.
      if ((scheduledAt ?? 0) >= gatewayBootMs) {
        log.info(
          `pending-actions: skipping ${type} action on ${key} (scheduled after boot, has active waiter)`,
        );
        found--; // Don't count in summary — not a leftover.
        continue;
      }

      // If the session has an active run, defer recovery until the run drains —
      // even if the action is older than MAX_AGE. Long-running sessions (ACP,
      // coding agents) can legitimately hold deferred actions for hours.
      const sessionId = entry.sessionId;
      if (sessionId && isEmbeddedPiRunActive(sessionId)) {
        log.info(
          `pending-actions: deferring ${type} action on ${key} (session has active run, waiting for drain)`,
        );
        // Fire-and-forget: waiter will execute recovery after the run ends.
        // The pendingAction stays in the store — if this waiter times out or
        // the gateway restarts again, the next recovery scan picks it up.
        void waitForEmbeddedPiRunEnd(sessionId, MAX_AGE_MS)
          .then(async (ended) => {
            if (!ended) {
              log.info(
                `pending-actions: deferred ${type} on ${key} timed out (will retry next restart)`,
              );
              return;
            }
            // Re-check that the marker still matches before executing — an operator
            // or a newer request may have cleared/replaced it while the run was active.
            const target = resolveGatewaySessionStoreTarget({ cfg: loadConfig(), key });
            const stillOurs = await updateSessionStore(target.storePath, (store) => {
              for (const sk of target.storeKeys) {
                const e = store[sk];
                if (
                  e?.pendingAction?.type === type &&
                  e.pendingAction.scheduledAt === scheduledAt
                ) {
                  return true;
                }
              }
              return false;
            });
            if (!stillOurs) {
              log.info(
                `pending-actions: deferred ${type} on ${key} no longer pending (cleared or replaced)`,
              );
              return;
            }
            log.info(`pending-actions: executing deferred ${type} on ${key} after run drained`);
            let ok = false;
            try {
              if (type === "reset") {
                const result = await performGatewaySessionReset({
                  key,
                  reason: persistedReason ?? "reset",
                  commandSource: "gateway:pending-action-recovery:deferred",
                });
                ok = result.ok;
              } else if (type === "compact") {
                const freshCfg = loadConfig();
                const agentId =
                  resolveAgentIdFromSessionKey(key) ?? resolveDefaultAgentId(freshCfg);
                const target = resolveGatewaySessionStoreTarget({ cfg: freshCfg, key });
                const sf = resolveSessionFilePath(
                  sessionId,
                  entry,
                  resolveSessionFilePathOptions({ agentId, storePath: target.storePath }),
                );
                const result = await compactEmbeddedPiSession({
                  sessionId,
                  sessionKey: key,
                  sessionFile: sf,
                  workspaceDir: resolveAgentWorkspaceDir(freshCfg, agentId),
                  config: freshCfg,
                  trigger: "manual",
                  customInstructions: instructions,
                  allowGatewaySubagentBinding: true,
                });
                ok = result.ok ?? result.compacted;
              }
            } catch (err) {
              log.warn(`pending-actions: deferred ${type} on ${key} failed: ${String(err)}`);
            }
            // Only clear the marker on success — on failure, leave for next restart.
            if (ok) {
              const target = resolveGatewaySessionStoreTarget({ cfg: loadConfig(), key });
              await updateSessionStore(target.storePath, (store) => {
                for (const sk of target.storeKeys) {
                  const e = store[sk];
                  if (
                    e?.pendingAction?.type === type &&
                    e.pendingAction.scheduledAt === scheduledAt
                  ) {
                    delete e.pendingAction;
                  }
                }
              });
            }
          })
          .catch((err) => {
            log.warn(`pending-actions: deferred recovery waiter for ${key} failed: ${String(err)}`);
          });
        continue;
      }

      // Expire stale actions only when the session is idle (active-run check above
      // already deferred running sessions).
      if (ageMs > MAX_AGE_MS) {
        log.info(
          `pending-actions: clearing stale ${type} action on ${key} (age: ${Math.round(ageMs / 60000)}m, session idle)`,
        );
        const target = resolveGatewaySessionStoreTarget({ cfg, key });
        await updateSessionStore(target.storePath, (store) => {
          for (const sk of target.storeKeys) {
            const e = store[sk];
            if (e?.pendingAction?.type === type && e.pendingAction.scheduledAt === scheduledAt) {
              delete e.pendingAction;
            }
          }
        });
        cleared++;
        continue;
      }

      // Recent — try to execute it
      log.info(
        `pending-actions: recovering ${type} action on ${key} (age: ${Math.round(ageMs / 60000)}m)`,
      );

      const succeeded = await executeRecovery({
        key,
        entry,
        type,
        scheduledAt,
        instructions,
        persistedReason,
        cfg,
        log,
      });
      if (succeeded) {
        recovered++;
      } else {
        failedEntries.push({ key, type, scheduledAt });
      }
    }

    if (found > 0) {
      log.info(
        `pending-actions: ${found} found, ${recovered} recovered, ${cleared} cleared (stale)`,
      );
    }

    // Schedule a single retry for keys that failed due to transient errors.
    if (failedEntries.length > 0) {
      log.info(
        `pending-actions: scheduling retry for ${failedEntries.length} failed key(s) in 60s`,
      );
      setTimeout(() => {
        void (async () => {
          try {
            const retryCfg = loadConfig();
            const retryStore = loadCombinedSessionStoreForGateway(retryCfg);
            for (const { key, type: origType, scheduledAt: origScheduledAt } of failedEntries) {
              const entry = retryStore.store[key];
              if (!entry?.pendingAction) {
                continue; // Already cleared or succeeded via another path.
              }
              // Only retry if the marker still matches what originally failed —
              // a newer deferred action may have replaced it.
              if (
                entry.pendingAction.type !== origType ||
                entry.pendingAction.scheduledAt !== origScheduledAt
              ) {
                log.info(`pending-actions: skipping retry for ${key} (marker was replaced)`);
                continue;
              }
              const sessionId = entry.sessionId;
              if (sessionId && isEmbeddedPiRunActive(sessionId)) {
                log.info(`pending-actions: skipping retry for ${key} (session has active run)`);
                continue;
              }
              const {
                type,
                scheduledAt,
                instructions,
                reason: persistedReason,
              } = entry.pendingAction;
              log.info(`pending-actions: retrying ${type} on ${key}`);
              const ok = await executeRecovery({
                key,
                entry,
                type,
                scheduledAt,
                instructions,
                persistedReason,
                cfg: retryCfg,
                log,
              });
              if (ok) {
                log.info(`pending-actions: retry succeeded for ${key}`);
              } else {
                log.warn(`pending-actions: retry failed for ${key} (will wait for next restart)`);
              }
            }
          } catch (err) {
            log.warn(`pending-actions: retry scan failed: ${String(err)}`);
          }
        })();
      }, 60_000);
    }
  } catch (err) {
    log.warn(`pending-actions: recovery scan failed: ${String(err)}`);
  }
}

/** Execute a single pending-action recovery and clear the marker on success. */
async function executeRecovery(params: {
  key: string;
  entry: { sessionId: string; sessionFile?: string };
  type: "compact" | "reset";
  scheduledAt: number;
  instructions?: string;
  persistedReason?: string;
  cfg: ReturnType<typeof loadConfig>;
  log: { info: (msg: string) => void; warn: (msg: string) => void };
}): Promise<boolean> {
  const { key, entry, type, scheduledAt, instructions, persistedReason, cfg, log } = params;
  let succeeded = false;
  try {
    if (type === "reset") {
      const resetResult = await performGatewaySessionReset({
        key,
        reason: persistedReason ?? "reset",
        commandSource: "gateway:pending-action-recovery",
      });
      if (resetResult.ok) {
        succeeded = true;
      } else {
        log.warn(
          `pending-actions: reset returned error for ${key}: ${resetResult.error?.message ?? "unknown"}`,
        );
      }
    } else if (type === "compact") {
      const agentId = resolveAgentIdFromSessionKey(key) ?? resolveDefaultAgentId(cfg);
      const target = resolveGatewaySessionStoreTarget({ cfg, key });
      const sessionFile = resolveSessionFilePath(
        entry.sessionId,
        entry,
        resolveSessionFilePathOptions({ agentId, storePath: target.storePath }),
      );
      const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);

      const compactResult = await compactEmbeddedPiSession({
        sessionId: entry.sessionId,
        sessionKey: key,
        sessionFile,
        workspaceDir,
        config: cfg,
        trigger: "manual",
        customInstructions: instructions,
        allowGatewaySubagentBinding: true,
      });
      if (compactResult.ok ?? compactResult.compacted) {
        succeeded = true;
      } else {
        log.warn(`pending-actions: compaction failed for ${key} (ok=false or compacted=false)`);
      }
    }
  } catch (err) {
    log.warn(`pending-actions: failed to recover ${type} on ${key}: ${String(err)}`);
  }

  if (succeeded) {
    const target = resolveGatewaySessionStoreTarget({ cfg, key });
    await updateSessionStore(target.storePath, (store) => {
      for (const sk of target.storeKeys) {
        const e = store[sk];
        if (e?.pendingAction?.type === type && e.pendingAction.scheduledAt === scheduledAt) {
          delete e.pendingAction;
        }
      }
    });
  }
  return succeeded;
}
