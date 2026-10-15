import { AsyncLocalStorage } from "node:async_hooks";
import { channel } from "node:diagnostics_channel";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { createAsyncLock } from "./json-files.js";

const owner = resolveGlobalSingleton(Symbol.for("openclaw.devicePairingLock"), () => ({
  lock: createAsyncLock(),
  current: new AsyncLocalStorage<{ active: boolean }>(),
}));
const diagnostics = channel("openclaw.device-pairing.lock");

/** Domain facades and their broker adapter share one admission interval. */
export async function withDevicePairingLock<T>(operate: () => Promise<T>): Promise<T> {
  if (owner.current.getStore()?.active) {
    return operate();
  }
  const queuedAt = diagnostics.hasSubscribers ? performance.now() : undefined;
  return owner.lock(async () => {
    const admittedAt = queuedAt === undefined ? undefined : performance.now();
    const scope = { active: true };
    try {
      return await owner.current.run(scope, operate);
    } finally {
      scope.active = false;
      if (queuedAt !== undefined && admittedAt !== undefined) {
        diagnostics.publish({
          queueMs: admittedAt - queuedAt,
          executionMs: performance.now() - admittedAt,
        });
      }
    }
  });
}
