import { toErrorObject } from "@openclaw/normalization-core/error-coercion";
import type { LeaseHeartbeatCarrier } from "./openclaw-state-lease-heartbeat-carrier.js";

export type LeaseHeartbeatCleanup = {
  readonly pending: boolean;
  close(): Promise<void>;
};

export function createLeaseHeartbeatCleanup(params: {
  cancel: () => void;
  finish: () => void | Promise<void>;
  release: () => void;
}) {
  let carrier: LeaseHeartbeatCarrier | undefined;
  const startupRenewals = new Set<Promise<unknown>>();
  let closed = false;
  let stopping: Promise<number> | undefined;
  let releasing: Promise<void> | undefined;
  let released = false;
  const finish = () =>
    (releasing ??= Promise.resolve()
      .then(async () => {
        try {
          await params.finish();
        } finally {
          params.release();
        }
      })
      .finally(() => {
        released = true;
      }));

  const cancel = () => {
    closed = true;
    params.cancel();
  };
  const stop = (): Promise<number> => {
    cancel();
    if (!stopping) {
      stopping = Promise.resolve().then(async () => {
        const exitCode = await carrier?.close();
        await Promise.allSettled(startupRenewals);
        await finish();
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
        (!closed && carrier === undefined) ||
        carrier?.pending === true ||
        startupRenewals.size !== 0 ||
        (releasing !== undefined && !released)
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
    start(acquire: () => LeaseHeartbeatCarrier, onFinishFailure: (error: Error) => void) {
      assertOpen();
      carrier = acquire();
      void carrier.closed
        .then(finish)
        .catch((error: unknown) =>
          onFinishFailure(toErrorObject(error, "State lease heartbeat admission cleanup failed")),
        );
      return carrier;
    },
    failStartup(error: unknown, abort: () => void): never {
      let failure = error;
      try {
        try {
          abort();
        } finally {
          params.release();
        }
      } catch (cleanupError) {
        failure = new AggregateError(
          [error, cleanupError],
          "State lease heartbeat construction cleanup failed",
          { cause: error },
        );
      }
      cancel();
      throw failure;
    },
  };
}
