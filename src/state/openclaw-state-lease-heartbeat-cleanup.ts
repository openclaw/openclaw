import type { LeaseHeartbeatCarrier } from "./openclaw-state-lease-heartbeat-carrier.js";

export type LeaseHeartbeatCleanup = {
  readonly pending: boolean;
  close(): Promise<void>;
};

export function createLeaseHeartbeatCleanup(params: { cancel: () => void }) {
  let carrier: LeaseHeartbeatCarrier | undefined;
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
        const exitCode = await carrier?.close();
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
        (!closed && carrier === undefined) ||
        carrier?.pending === true ||
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
    start(acquire: () => LeaseHeartbeatCarrier) {
      assertOpen();
      carrier = acquire();
      return carrier;
    },
    failStartup(error: unknown): never {
      cancel();
      throw error;
    },
  };
}
