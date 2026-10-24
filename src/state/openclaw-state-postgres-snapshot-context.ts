import { AsyncLocalStorage } from "node:async_hooks";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";

/** The retained discovery owner selects the same MVCC view for native and worker reads. */
export const postgresStateReadSnapshot = resolveGlobalSingleton(
  Symbol.for("openclaw.postgresStateReadSnapshot"),
  () => new AsyncLocalStorage<{ path: string; snapshot: string }>(),
);
