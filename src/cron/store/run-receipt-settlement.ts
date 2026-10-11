import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import type { OpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.types.js";
import { runCronRuntimeMutation } from "../service/runtime-mutation.js";
import type { CronRunReceiptHandle, CronRunReceiptStatus } from "./run-receipt.types.js";

type CronRunReceiptFinish = {
  handle: CronRunReceiptHandle;
  status: Exclude<CronRunReceiptStatus, "running">;
  finishedAtMs: number;
  error?: string;
  env?: NodeJS.ProcessEnv;
};
/** One instance belongs to the receipt store; SQL kernels never import this host state. */
export function createCronRunReceiptSettlementOwner(callbacks: {
  revisionError: (receiptId: string, message: string) => Error;
}) {
  const CRON_RUN_RECEIPT_FINISH_RETRY_MS = 1_000;
  const locallyOwnedReceipts = new Set<string>();
  type CronRunReceiptSettlement = {
    finish?: CronRunReceiptFinish;
    finishContext?: OpenClawStateWorkerContext;
    retained: number;
    settled: boolean;
    settle: () => void;
    releaseRequested: boolean;
    onFinishError: (error: unknown) => void;
  };
  const pendingReceiptSettlements = new Map<string, CronRunReceiptSettlement>();
  type CronRunReceiptFinishRetry = {
    finish: CronRunReceiptFinish;
    context: OpenClawStateWorkerContext;
    timer: NodeJS.Timeout | null;
  };
  const pendingReceiptFinishRetries = new Map<string, CronRunReceiptFinishRetry>();

  /** Keeps the durable lease live when timeout/cancel returns before the runner. */
  function trackCronRunReceiptSettlement(params: {
    handle: CronRunReceiptHandle;
    settlement: Promise<unknown>;
    onFinishError: (error: unknown) => void;
  }): void {
    const receiptId = params.handle.receiptId;
    const pending: CronRunReceiptSettlement = {
      releaseRequested: false,
      retained: 0,
      settled: false,
      settle: () => {},
      onFinishError: params.onFinishError,
    };
    pendingReceiptSettlements.set(receiptId, pending);
    const settle = () => {
      if (pendingReceiptSettlements.get(receiptId) !== pending) {
        return;
      }
      pending.settled = true;
      if (pending.retained > 0) {
        return;
      }
      pendingReceiptSettlements.delete(receiptId);
      if (pending.finish) {
        void finishCronRunReceiptAsync(pending.finish, pending.finishContext).catch(
          pending.onFinishError,
        );
      } else if (pending.releaseRequested) {
        locallyOwnedReceipts.delete(receiptId);
      }
    };
    pending.settle = settle;
    void params.settlement.then(settle, settle);
  }

  /** Keep the runner's settlement owner alive across a worker commit and host publication. */
  function retainCronRunReceiptSettlement(handle: CronRunReceiptHandle) {
    const pending = pendingReceiptSettlements.get(handle.receiptId);
    if (pending) {
      pending.retained += 1;
    }
    let released = false;
    return {
      pending: pending !== undefined,
      assertCurrent() {
        if (pendingReceiptSettlements.get(handle.receiptId) !== pending) {
          throw callbacks.revisionError(
            handle.receiptId,
            "cron runner settlement changed before commit",
          );
        }
      },
      deferFinish(finish: CronRunReceiptFinish, context: OpenClawStateWorkerContext) {
        if (!pending || released) {
          throw new Error("Cron deferred finish lost its retained settlement");
        }
        pending.finish ??= finish;
        pending.finishContext ??= context;
      },
      release() {
        if (released) {
          return;
        }
        released = true;
        if (pending) {
          pending.retained -= 1;
          if (pending.settled) {
            pending.settle();
          }
        }
      },
    };
  }

  function clearCronRunReceiptFinishRetry(receiptId: string): void {
    const pending = pendingReceiptFinishRetries.get(receiptId);
    if (pending?.timer) {
      clearTimeout(pending.timer);
    }
    pendingReceiptFinishRetries.delete(receiptId);
  }

  function queueCronRunReceiptFinishRetry(
    finish: CronRunReceiptFinish,
    context: OpenClawStateWorkerContext,
  ): void {
    const receiptId = finish.handle.receiptId;
    let pending = pendingReceiptFinishRetries.get(receiptId);
    if (!pending) {
      pending = { finish, context, timer: null };
      pendingReceiptFinishRetries.set(receiptId, pending);
    }
    if (pending.timer) {
      return;
    }
    // Keep local ownership until a retry commits. Foreign recovery requires
    // owner exit, PID reuse, or expiry of an unverifiable process identity.
    pending.timer = setTimeout(() => {
      pending!.timer = null;
      void finishCronRunReceiptAsync(pending!.finish, pending!.context).catch(() => undefined);
    }, CRON_RUN_RECEIPT_FINISH_RETRY_MS);
    pending.timer.unref?.();
  }

  /** The asynchronous settlement owner uses the same broker as the marker transaction. */
  async function finishCronRunReceiptAsync(
    params: CronRunReceiptFinish,
    context = captureOpenClawStateWorkerContext(params.env ? { env: params.env } : {}),
  ): Promise<void> {
    const pending = pendingReceiptSettlements.get(params.handle.receiptId);
    if (pending) {
      pending.finish ??= params;
      pending.finishContext ??= context;
      return;
    }
    let retrySafe = false;
    try {
      await runCronRuntimeMutation({
        context,
        type: "cron.finishReceipt",
        input: {
          storeKey: params.handle.storeKey,
          terminal: {
            handle: { ...params.handle },
            status: params.status,
            finishedAtMs: params.finishedAtMs,
            error: params.error,
          },
        },
        assertCurrent() {
          if (pendingReceiptSettlements.has(params.handle.receiptId)) {
            throw callbacks.revisionError(
              params.handle.receiptId,
              "cron runner settlement changed before finish",
            );
          }
        },
        // A runner may appear after dispatch; receipt identity still guards the terminal write.
        snapshot: {},
        onSettled(outcome) {
          retrySafe = outcome === "not-committed";
        },
        publish() {
          clearCronRunReceiptFinishRetry(params.handle.receiptId);
          locallyOwnedReceipts.delete(params.handle.receiptId);
        },
      });
    } catch (error) {
      // Retry only a known rollback whose captured physical owner still exists.
      try {
        context.admission.assertCurrent();
      } catch {
        retrySafe = false;
      }
      if (retrySafe) {
        queueCronRunReceiptFinishRetry(params, context);
      } else {
        // Native work has settled. An uncertain or retired writer leaves its exact
        // durable receipt for recovery instead of retaining a dead local fence.
        clearCronRunReceiptFinishRetry(params.handle.receiptId);
        releaseLocalCronRunReceiptOwnership(params.handle);
      }
      throw error;
    }
  }

  /** Releases only this process's liveness proof after terminal persistence fails. */
  function releaseLocalCronRunReceiptOwnership(handle: CronRunReceiptHandle): void {
    const pending = pendingReceiptSettlements.get(handle.receiptId);
    if (pending) {
      pending.releaseRequested = true;
      return;
    }
    if (pendingReceiptFinishRetries.has(handle.receiptId)) {
      return;
    }
    locallyOwnedReceipts.delete(handle.receiptId);
  }

  return {
    claimLocalCronRunReceiptOwnership: (handle: CronRunReceiptHandle) => {
      locallyOwnedReceipts.add(handle.receiptId);
    },
    owns: (receiptId: string) => locallyOwnedReceipts.has(receiptId),
    listLocallyOwnedCronRunReceiptIds: () => [...locallyOwnedReceipts],
    trackCronRunReceiptSettlement,
    retainCronRunReceiptSettlement,
    finishCronRunReceiptAsync,
    releaseLocalCronRunReceiptOwnership,
  };
}
