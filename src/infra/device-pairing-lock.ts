import { AsyncLocalStorage } from "node:async_hooks";
import { threadId } from "node:worker_threads";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { createAsyncLock } from "./json-files.js";

type PairingLockScope = {
  active: boolean;
  operation: string;
  startedAt: number;
};

export type DevicePairingWaitObservation = {
  longestWait?: {
    waitMs: number;
    holderAtEnqueue: { operation: string; threadId: number; heldMs: number };
  };
};

const owner = resolveGlobalSingleton<{
  lock: ReturnType<typeof createAsyncLock>;
  current: AsyncLocalStorage<PairingLockScope>;
  waits: AsyncLocalStorage<DevicePairingWaitObservation>;
  holder?: PairingLockScope;
}>(Symbol.for("openclaw.devicePairingLock"), () => ({
  lock: createAsyncLock(),
  current: new AsyncLocalStorage<PairingLockScope>(),
  waits: new AsyncLocalStorage<DevicePairingWaitObservation>(),
}));

/** The existing slow-connect logger consumes at most one contended pairing wait. */
export function withDevicePairingWaitObservation<T>(
  observation: DevicePairingWaitObservation,
  run: () => T,
): T {
  return owner.waits.run(observation, run);
}

/** Domain facades and their broker adapter share one admission interval. */
export async function withDevicePairingLock<T>(
  operate: () => Promise<T>,
  operation = "devicePairing",
): Promise<T> {
  if (owner.current.getStore()?.active) {
    return operate();
  }
  const observation = owner.waits.getStore();
  const holder = observation ? owner.holder : undefined;
  const enqueuedAt = holder ? Date.now() : 0;
  return owner.lock(async () => {
    const scope: PairingLockScope = {
      active: true,
      operation: operation.slice(0, 120),
      startedAt: Date.now(),
    };
    owner.holder = scope;
    if (observation && holder) {
      const waitMs = scope.startedAt - enqueuedAt;
      if (waitMs > (observation.longestWait?.waitMs ?? -1)) {
        observation.longestWait = {
          waitMs,
          holderAtEnqueue: {
            operation: holder.operation,
            threadId,
            heldMs: enqueuedAt - holder.startedAt,
          },
        };
      }
    }
    try {
      return await owner.current.run(scope, operate);
    } finally {
      scope.active = false;
      owner.holder = undefined;
    }
  });
}
