import { AsyncLocalStorage } from "node:async_hooks";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";

// Host-owned placement constraint, not configuration or model input. It carries
// no credential/environment overrides and cannot turn a socket peer into a child.
const context = resolveGlobalSingleton(
  Symbol.for("openclaw.ownedRuntimeProcessContext"),
  () => new AsyncLocalStorage<true>(),
);
export function requiresOwnedRuntimeProcess(): boolean {
  return context.getStore() === true;
}
export function withOwnedRuntimeProcess<T>(run: () => T): T {
  return context.run(true, run);
}
