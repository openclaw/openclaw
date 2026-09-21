import { AsyncLocalStorage } from "node:async_hooks";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { createAsyncLock } from "./json-files.js";

const owner = resolveGlobalSingleton(Symbol.for("openclaw.devicePairingLock"), () => ({
  lock: createAsyncLock(),
  current: new AsyncLocalStorage<{ active: boolean }>(),
}));

/** Domain facades and their broker adapter share one admission interval. */
export async function withDevicePairingLock<T>(operate: () => Promise<T>): Promise<T> {
  if (owner.current.getStore()?.active) {
    return operate();
  }
  return owner.lock(async () => {
    const scope = { active: true };
    try {
      return await owner.current.run(scope, operate);
    } finally {
      scope.active = false;
    }
  });
}
