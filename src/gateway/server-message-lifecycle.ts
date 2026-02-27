import { dispatchResumedTurn } from "../auto-reply/dispatch.js";
import { createReplyDispatcher } from "../auto-reply/reply/reply-dispatcher.js";
import { routeReply } from "../auto-reply/reply/route-reply.js";
import type { OpenClawConfig } from "../config/config.js";
import { logVerbose } from "../globals.js";
import {
  MAX_TURN_RECOVERY_AGE_MS,
  TURN_PRUNE_AGE_MS,
  failStaleTurns,
  finalizeTurn,
  hydrateTurnContext,
  listRecoverableTurns,
  pruneTurns,
  recordTurnRecoveryFailure,
} from "../infra/message-lifecycle/turns.js";
import { deliverOutboundPayloads } from "../infra/outbound/deliver.js";
import {
  OUTBOX_PRUNE_AGE_MS,
  getOutboxStatusForTurn,
  importLegacyFileQueue,
  pruneOutbox,
  recoverPendingDeliveries,
} from "../infra/outbound/delivery-queue.js";
import { sleep } from "../utils.js";

type LifecycleWorkerLogger = {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
  child?(name: string): LifecycleWorkerLogger;
};

export type LifecycleWorkerHandle = {
  stop: () => Promise<void>;
};

type StartLifecycleWorkersParams = {
  cfg: OpenClawConfig;
  log: LifecycleWorkerLogger;
  stateDir?: string;
  outboxIntervalMs?: number;
  turnIntervalMs?: number;
  maxTurnsPerPass?: number;
};

function childLogger(logger: LifecycleWorkerLogger, name: string): LifecycleWorkerLogger {
  return typeof logger.child === "function" ? logger.child(name) : logger;
}

export async function startMessageLifecycleWorkers(
  params: StartLifecycleWorkersParams,
): Promise<LifecycleWorkerHandle> {
  const outboxLog = childLogger(params.log, "outbox-worker");
  const turnLog = childLogger(params.log, "turn-worker");

  // Record startup time before any long startup work. The outbox worker uses this to skip
  // entries enqueued after startup (those are being delivered on the direct path and must
  // not be double-delivered). Only entries older than this timestamp are crash survivors.
  // Must be taken before importLegacyFileQueue so entries enqueued during import are not
  // misclassified as pre-start crash survivors and retried in the same cycle.
  const startupCutoff = Date.now();

  await importLegacyFileQueue(params.stateDir).catch((err) => {
    params.log.warn(`message-lifecycle: legacy queue import failed: ${String(err)}`);
  });

  const outboxIntervalMs = Math.max(250, Math.floor(params.outboxIntervalMs ?? 1000));
  const turnIntervalMs = Math.max(250, Math.floor(params.turnIntervalMs ?? 1200));
  const maxTurnsPerPass = Math.max(1, Math.floor(params.maxTurnsPerPass ?? 16));

  let stopped = false;

  const runOutboxPass = async (): Promise<void> => {
    const summary = await recoverPendingDeliveries({
      deliver: deliverOutboundPayloads,
      log: outboxLog,
      cfg: params.cfg,
      stateDir: params.stateDir,
      maxRecoveryMs: Math.max(750, Math.floor(outboxIntervalMs * 0.75)),
      startupCutoff,
    });
    if (
      summary.recovered > 0 ||
      summary.failed > 0 ||
      summary.skippedMaxRetries > 0 ||
      summary.skippedStartupCutoff > 0
    ) {
      outboxLog.info(
        `pass recovered=${summary.recovered} failed=${summary.failed} skippedMaxRetries=${summary.skippedMaxRetries} deferredBackoff=${summary.deferredBackoff} skippedStartupCutoff=${summary.skippedStartupCutoff}`,
      );
    }
    pruneOutbox(OUTBOX_PRUNE_AGE_MS, params.stateDir);
  };

  const runTurnPass = async (): Promise<void> => {
    const stale = failStaleTurns(MAX_TURN_RECOVERY_AGE_MS, { stateDir: params.stateDir });
    if (stale > 0) {
      turnLog.warn(`marked ${stale} stale turn(s) as failed_terminal`);
    }

    const recoverable = listRecoverableTurns({ stateDir: params.stateDir }).slice(
      0,
      maxTurnsPerPass,
    );
    for (const turn of recoverable) {
      if (stopped) {
        return;
      }

      const outbox = getOutboxStatusForTurn(turn.id, params.stateDir);
      if (outbox.queued > 0) {
        continue;
      }
      if (outbox.delivered > 0 && outbox.failed === 0) {
        finalizeTurn(turn.id, "delivered", { stateDir: params.stateDir });
        continue;
      }
      if (outbox.failed > 0) {
        finalizeTurn(turn.id, "failed", { stateDir: params.stateDir });
        continue;
      }

      const ctx = hydrateTurnContext(turn);
      if (!ctx) {
        const failure = recordTurnRecoveryFailure(turn.id, "invalid turn payload", {
          stateDir: params.stateDir,
        });
        turnLog.warn(
          `turn ${turn.id}: invalid payload (attempt=${failure.attempts}, markedFailed=${failure.markedFailed})`,
        );
        continue;
      }

      const dispatcher = createReplyDispatcher({
        deliver: async (payload) => {
          const channel = ctx.OriginatingChannel;
          const to = ctx.OriginatingTo ?? ctx.To;
          if (!channel || !to) {
            throw new Error("missing route target for recovered turn");
          }
          const result = await routeReply({
            payload,
            channel,
            to,
            turnId: turn.id,
            sessionKey: ctx.SessionKey,
            accountId: ctx.AccountId,
            threadId: ctx.MessageThreadId,
            cfg: params.cfg,
          });
          if (!result.ok) {
            throw new Error(result.error ?? "route-reply failed");
          }
        },
      });
      // Outbox rows are created by routeReply → deliverOutboundPayloads in the deliver
      // closure above. Disabling setDeliveryQueueContext prevents the dispatcher from
      // also enqueueing via deliveryQueueContext, which would create duplicate outbox rows
      // when shouldRouteToOriginating is false (same-surface direct delivery path).
      dispatcher.setDeliveryQueueContext = undefined;

      try {
        await dispatchResumedTurn({
          turnId: turn.id,
          ctx,
          cfg: params.cfg,
          dispatcher,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const failure = recordTurnRecoveryFailure(turn.id, message, {
          stateDir: params.stateDir,
        });
        turnLog.warn(
          `turn ${turn.id}: recovery failed (attempt=${failure.attempts}, markedFailed=${failure.markedFailed}): ${message}`,
        );
      } finally {
        dispatcher.markComplete();
        await dispatcher.waitForIdle().catch((err) => {
          logVerbose(`message-lifecycle: dispatcher idle wait failed: ${String(err)}`);
        });
      }
    }

    pruneTurns(TURN_PRUNE_AGE_MS, { stateDir: params.stateDir });
  };

  const outboxTask = (async () => {
    while (!stopped) {
      try {
        await runOutboxPass();
      } catch (err) {
        outboxLog.error(`outbox worker pass failed: ${String(err)}`);
      }
      if (stopped) {
        break;
      }
      await sleep(outboxIntervalMs);
    }
  })();

  const turnTask = (async () => {
    while (!stopped) {
      try {
        await runTurnPass();
      } catch (err) {
        turnLog.error(`turn worker pass failed: ${String(err)}`);
      }
      if (stopped) {
        break;
      }
      await sleep(turnIntervalMs);
    }
  })();

  return {
    stop: async () => {
      if (stopped) {
        return;
      }
      stopped = true;
      await Promise.allSettled([outboxTask, turnTask]);
    },
  };
}
