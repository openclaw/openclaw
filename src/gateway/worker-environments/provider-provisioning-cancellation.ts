import { toErrorObject } from "@openclaw/normalization-core/error-coercion";
import {
  getGatewayRestartDrainSignal,
  onGatewaySuspendAdmissionChange,
} from "../../process/gateway-work-admission.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { WorkerEnvironmentReconcileInterruptedError } from "./environment-errors.js";
import type { WorkerEnvironmentRecord, WorkerEnvironmentStore } from "./store.js";

export function createWorkerReconcileCancellation(ownerSignal: AbortSignal) {
  const controller = new AbortController();
  const interrupt = () =>
    controller.abort(
      new WorkerEnvironmentReconcileInterruptedError("Worker reconciliation paused"),
    );
  const lifetime = AbortSignal.any([ownerSignal, getGatewayRestartDrainSignal()]);
  lifetime.addEventListener("abort", interrupt, { once: true });
  const unsubscribeSuspend = onGatewaySuspendAdmissionChange((phase) => {
    if (phase !== "accepting") {
      interrupt();
    }
  });
  if (lifetime.aborted) {
    interrupt();
  }
  return {
    signal: controller.signal,
    [Symbol.dispose]() {
      lifetime.removeEventListener("abort", interrupt);
      unsubscribeSuspend();
    },
  };
}

export function createWorkerProvisionCancellation(
  store: WorkerEnvironmentStore,
  record: WorkerEnvironmentRecord,
  signal: AbortSignal,
) {
  let owners = 1;
  const settled = createDeferredCore();
  let intentError: Error | undefined;
  let stopIntent: Promise<void> | undefined;
  const persistStop = async () => {
    try {
      await store.ready();
      const current = store.get(record.environmentId);
      if (
        current?.provisionOperationId === record.provisionOperationId &&
        current.ownerEpoch === record.ownerEpoch &&
        (current.state === "requested" ||
          current.state === "provisioning" ||
          current.state === "bootstrapping")
      ) {
        await store.requestDestroy({
          environmentId: current.environmentId,
          state: current.state,
          assertCurrent: () => {
            const owner = store.get(record.environmentId);
            if (
              owner?.provisionOperationId !== record.provisionOperationId ||
              owner.ownerEpoch !== record.ownerEpoch
            ) {
              throw new Error("Worker cancellation owner changed before recording intent");
            }
          },
        });
      }
    } catch (error) {
      // Abort listeners cannot throw into the caller. The operation still drains its child,
      // then reports the failed durable intent through its ordinary completion path.
      intentError = toErrorObject(error, "Worker cancellation intent failed");
    }
  };
  const requestStop = () => {
    if (!(signal.reason instanceof WorkerEnvironmentReconcileInterruptedError)) {
      stopIntent ??= persistStop();
    }
  };
  signal.addEventListener("abort", requestStop, { once: true });
  if (signal.aborted) {
    requestStop();
  }
  const close = async () => {
    if (--owners === 0) {
      signal.removeEventListener("abort", requestStop);
      await stopIntent;
      settled.resolve();
    } else {
      await stopIntent;
    }
  };
  const settleStopIntent = async () => {
    await stopIntent;
    if (signal.reason instanceof WorkerEnvironmentReconcileInterruptedError) {
      throw signal.reason;
    }
    if (intentError !== undefined) {
      throw intentError;
    }
  };
  return {
    signal,
    settled: settled.promise,
    close,
    settleStopIntent,
    assertActive: () => {
      if (intentError !== undefined) {
        throw intentError;
      }
      signal.throwIfAborted();
    },
    retainProvider: <T>(run: () => Promise<T>) => {
      // A caller timeout does not settle the queued provider. Retain cancellation until
      // that exact operation exits, including while later cleanup waits behind it.
      owners += 1;
      return async () => {
        try {
          signal.throwIfAborted();
          return await run();
        } finally {
          await close();
        }
      };
    },
  };
}
