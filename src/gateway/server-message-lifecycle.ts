import type { OpenClawConfig } from "../config/config.js";
import { deliverOutboundPayloads } from "../infra/outbound/deliver.js";
import {
  OUTBOX_PRUNE_AGE_MS,
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
  /** Live config getter — called on each worker pass so hot-reloaded values take effect. */
  getCfg: () => OpenClawConfig;
  log: LifecycleWorkerLogger;
  stateDir?: string;
  outboxIntervalMs?: number;
};

function childLogger(logger: LifecycleWorkerLogger, name: string): LifecycleWorkerLogger {
  return typeof logger.child === "function" ? logger.child(name) : logger;
}

export async function startMessageLifecycleWorkers(
  params: StartLifecycleWorkersParams,
): Promise<LifecycleWorkerHandle> {
  const outboxLog = childLogger(params.log, "outbox-worker");

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

  let stopped = false;

  const runOutboxPass = async (): Promise<void> => {
    const summary = await recoverPendingDeliveries({
      deliver: deliverOutboundPayloads,
      log: outboxLog,
      cfg: params.getCfg(),
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

  return {
    stop: async () => {
      if (stopped) {
        return;
      }
      stopped = true;
      await Promise.allSettled([outboxTask]);
    },
  };
}
