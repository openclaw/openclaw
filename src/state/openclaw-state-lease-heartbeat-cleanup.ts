import type { Worker } from "node:worker_threads";
import { createDeferredCore } from "../shared/deferred.js";

export type LeaseHeartbeatCleanup = {
  readonly pending: boolean;
  close(): Promise<void>;
};

export function createLeaseHeartbeatCleanup(params: { cancel: () => void }) {
  let worker: Worker | undefined;
  let exitCode: number | undefined;
  const exited = createDeferredCore<number>();
  const startupRenewals = new Set<Promise<unknown>>();
  let closed = false;
  let stopping: Promise<number> | undefined;

  const cancel = () => {
    closed = true;
    params.cancel();
  };
  const stop = (): Promise<number> => {
    cancel();
    if (!stopping) {
      stopping = Promise.resolve().then(async () => {
        if (worker && exitCode === undefined) {
          await worker.terminate();
          // A terminate result is not a substitute for the native exit event.
          await exited.promise;
        }
        await Promise.allSettled(startupRenewals);
        return exitCode ?? 0;
      });
      void stopping.catch(() => {
        stopping = undefined;
      });
    }
    return stopping;
  };
  const cleanup: LeaseHeartbeatCleanup = {
    get pending() {
      // Publication precedes acquisition, so startup itself retains this owner.
      return (
        (!closed && worker === undefined) ||
        (worker !== undefined && exitCode === undefined) ||
        startupRenewals.size !== 0
      );
    },
    async close() {
      await stop();
    },
  };
  const assertOpen = () => {
    if (closed) {
      throw new Error("state lease heartbeat closed before startup");
    }
  };
  return {
    cleanup,
    stop,
    async joinStartupRenewals() {
      await Promise.allSettled(startupRenewals);
    },
    retainStartupRenewal(operation: Promise<unknown>) {
      assertOpen();
      startupRenewals.add(operation);
      const settled = () => startupRenewals.delete(operation);
      void operation.then(settled, settled);
    },
    start(createWorker: () => Worker) {
      assertOpen();
      worker = createWorker();
      worker.once("exit", (code) => {
        exitCode = code;
        exited.resolve(code);
      });
      return worker;
    },
    failStartup(error: unknown): never {
      cancel();
      throw error;
    },
  };
}
