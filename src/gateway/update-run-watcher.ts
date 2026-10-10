import { formatErrorMessage } from "../infra/errors.js";
import type { GatewayScheduledJob } from "../infra/gateway-scheduler.js";
import type { UpdateCheckLifecycle } from "../infra/update-check-lifecycle.js";
import { isPendingControlPlaneUpdateRestartSentinel } from "../infra/update-control-plane-sentinel.js";
import { reconcileInterruptedUpdateRuns } from "../infra/update-run-interruption.js";
import {
  getUpdateRunAsync,
  listUpdateRunsAsync,
  reconcileAbandonedUpdateRunsAsync,
} from "../infra/update-run-ledger.js";
import type { UpdateRunPhase, UpdateRunRecord } from "../infra/update-run-record.js";
import { AsyncWorkScope } from "../shared/async-work-scope.js";
import { reconcileOpenClawStateSchemaPublication } from "../state/openclaw-state-db.js";
import { GATEWAY_EVENT_UPDATE_RUN_CHANGED } from "./events.js";
import type { GatewayBroadcastFn } from "./server-broadcast-types.js";

const UPDATE_RUN_POLL_MS = 2_000;
const TERMINAL_SENTINEL_WAIT_MS = 30 * 60_000;
let wakeCurrentWatcher: (() => void) | undefined;

/** Wake the Gateway-owned watcher when this process admits an update. */
export function wakeUpdateRunWatcher(): void {
  wakeCurrentWatcher?.();
}

/** The update-check lifecycle joins notices and their transport tails before Gateway teardown. */
export function startUpdateRunWatcher(params: {
  lifecycle: UpdateCheckLifecycle;
  broadcast: GatewayBroadcastFn;
  log: { warn: (message: string) => void };
}): { stop: () => Promise<void> } {
  const work = new AsyncWorkScope();
  const scheduler = params.lifecycle.scheduler.scope();
  let timer: GatewayScheduledJob | undefined;
  let publicationTimer: GatewayScheduledJob | undefined;
  let watched:
    | { runId: string; revision?: number; phase?: UpdateRunPhase; sentinelDeadline?: number }
    | undefined;
  let notices = Promise.resolve();
  let reconciled: UpdateRunRecord[] = [];
  let polling: { runId?: string; terminalRevision?: number } | undefined;
  let pollAgain = false;
  let scanning: Promise<void> | undefined;
  let scanRequested = false;
  let reconcileAllRequested = false;

  const schedulePublication = () => {
    publicationTimer?.cancel();
    publicationTimer = undefined;
    if (work.isClosing) {
      return;
    }
    try {
      const blocker = reconcileOpenClawStateSchemaPublication();
      if (blocker?.publishAfterMs != null) {
        // Deadline belongs to the ledger row, so process restarts never restart the grace.
        publicationTimer = scheduler.schedule({
          id: "update.schema-publication",
          atMs: blocker.publishAfterMs,
          run: schedulePublication,
        });
      }
    } catch (error) {
      params.log.warn(`state schema publication deferred: ${formatErrorMessage(error)}`);
    }
  };

  const scanOnce = async (reconcileAll: boolean): Promise<void> => {
    if (work.isClosing) {
      return;
    }
    timer?.cancel();
    timer = undefined;
    try {
      const abandoned = await reconcileAbandonedUpdateRunsAsync(
        { legacyOnly: !reconcileAll },
        { signal: work.signal },
      );
      if (work.isClosing) {
        return;
      }
      reconciled.push(...abandoned.filter((run) => run.runId !== watched?.runId));
      schedulePublication();
      const nextActive = watched?.sentinelDeadline
        ? (await listUpdateRunsAsync({ active: true, limit: 1 }))[0]
        : undefined;
      const observed =
        nextActive ??
        (watched
          ? await getUpdateRunAsync(watched.runId)
          : (reconciled.shift() ?? (await listUpdateRunsAsync({ active: true, limit: 1 }))[0]));
      if (work.isClosing) {
        return;
      }
      if (!observed) {
        watched = undefined;
        return;
      }
      // A settlement may arrive while the active-run lookup is awaiting its snapshot.
      const run = reconciled.reduce(
        (latest, entry) =>
          entry.runId === latest.runId && entry.updatedAtMs > latest.updatedAtMs ? entry : latest,
        observed,
      );
      reconciled = reconciled.filter((entry) => entry.runId !== run.runId);
      if (watched?.runId !== run.runId) {
        watched = { runId: run.runId };
      }
      const terminal = run.status !== "running";
      params.lifecycle.campaign?.reconcileRun(run);
      let awaitingSentinel = false;
      if (watched.revision !== run.updatedAtMs || terminal) {
        const { refreshLatestUpdateRestartSentinel, getLatestUpdateRestartSentinel } =
          await import("./server-update-sentinel.js");
        let sentinelFailed = false;
        const sentinel = await refreshLatestUpdateRestartSentinel(
          undefined,
          () => !work.isClosing && params.lifecycle.isCurrent(),
        ).catch((error: unknown) => {
          sentinelFailed = true;
          params.log.warn(`update sentinel refresh failed: ${formatErrorMessage(error)}`);
          return getLatestUpdateRestartSentinel();
        });
        if (work.isClosing || !params.lifecycle.isCurrent()) {
          return;
        }
        // Older detached updaters may commit terminal history before their notification.
        // Keep that handoff with this watcher, never with reconnecting status clients.
        if (
          terminal &&
          (sentinelFailed ||
            (sentinel?.stats?.runId === run.runId &&
              isPendingControlPlaneUpdateRestartSentinel(sentinel)))
        ) {
          watched.sentinelDeadline ??= scheduler.now() + TERMINAL_SENTINEL_WAIT_MS;
          awaitingSentinel = scheduler.now() < watched.sentinelDeadline;
          if (!awaitingSentinel) {
            params.log.warn(`update run ${run.runId} terminal notification remained pending`);
          }
        }
        params.broadcast(GATEWAY_EVENT_UPDATE_RUN_CHANGED, {
          runId: run.runId,
          phase: run.phase,
          status: run.status,
          updatedAtMs: run.updatedAtMs,
        });
        watched.revision = run.updatedAtMs;
        if (terminal && polling?.runId === run.runId) {
          polling.terminalRevision = Math.max(polling.terminalRevision ?? 0, run.updatedAtMs);
        }
      }
      if (watched.phase !== run.phase) {
        watched.phase = run.phase;
        // The command owns refusals before acknowledgement. Only an admitted
        // conversation with durable ack custody receives an automatic final notice.
        const acknowledged = run.steps.some(
          (step) => step.step === "notice:ack" && step.status === "completed",
        );
        if (run.phase === "activating" || (terminal && acknowledged)) {
          notices = work.track(() =>
            notices
              .then(async () => {
                if (work.isClosing) {
                  return;
                }
                const { notifyUpdateRunPhase } = await import("./update-run-notice.runtime.js");
                if (!work.isClosing) {
                  await notifyUpdateRunPhase(run);
                }
              })
              .catch((error: unknown) => {
                params.log.warn(`update run notice failed: ${formatErrorMessage(error)}`);
              }),
          );
        }
      }
      if (terminal && !awaitingSentinel) {
        watched = undefined;
        void scan(reconcileAll);
        return;
      }
      // Named freshness-poll exception: the detached orchestrator writes the
      // shared ledger. Observe one active run until terminal or teardown so a
      // late repair still clears the clients' update-in-progress state.
      timer = scheduler.schedule({
        id: "update.run-poll",
        delayMs: UPDATE_RUN_POLL_MS,
        run: poll,
      });
    } catch (error) {
      if (!work.isClosing) {
        watched = undefined;
        params.log.warn(`update run watcher stopped: ${formatErrorMessage(error)}`);
      }
    }
  };
  const scan = (requestReconciliation = true): Promise<void> => {
    if (work.isClosing) {
      return Promise.resolve();
    }
    scanRequested = true;
    reconcileAllRequested ||= requestReconciliation;
    if (scanning) {
      return scanning;
    }
    scanning = work.track(async () => {
      try {
        while (scanRequested && !work.isClosing) {
          const reconcileAll = reconcileAllRequested;
          scanRequested = false;
          reconcileAllRequested = false;
          await scanOnce(reconcileAll);
        }
      } finally {
        scanning = undefined;
      }
    });
    return scanning;
  };
  const poll = () => {
    if (work.isClosing) {
      return;
    }
    timer = undefined;
    // Candidate verification must not delay terminal observations or schema publication.
    // Other abandonment still waits for candidate verification.
    void scan(false);
    if (polling) {
      pollAgain = true;
      return;
    }
    polling = {};
    const cycle = polling;
    void work
      .track(async () => {
        const settled = await reconcileInterruptedUpdateRuns({ signal: work.signal }, (runId) => {
          cycle.runId = runId;
        });
        if (work.isClosing) {
          return;
        }
        // A timer scan can publish this cycle's commit before its worker reply arrives.
        reconciled.push(
          ...settled.filter(
            (run) =>
              run.runId !== watched?.runId &&
              (run.runId !== cycle.runId ||
                cycle.terminalRevision === undefined ||
                run.updatedAtMs > cycle.terminalRevision),
          ),
        );
        // The first history read may still be pending when verification settles.
        await scan();
      })
      .catch(async (error: unknown) => {
        if (!work.isClosing) {
          params.log.warn(`update run reconciliation deferred: ${formatErrorMessage(error)}`);
          await scan();
        }
      })
      .finally(() => {
        polling = undefined;
        if (pollAgain) {
          pollAgain = false;
          if (!timer) {
            poll();
          }
        }
      });
  };
  const wake = () => {
    if (!timer && !watched) {
      poll();
    }
  };
  wakeCurrentWatcher = wake;
  wake();
  return {
    stop: async () => {
      work.beginClose();
      if (wakeCurrentWatcher === wake) {
        wakeCurrentWatcher = undefined;
      }
      await Promise.all([scheduler.stop(), work.drain()]);
    },
  };
}
