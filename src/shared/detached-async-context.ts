import { resolveGlobalSingleton } from "./global-singleton.js";

// Shared queue owners also run in the browser, which has no Node async context.
const asyncHooks =
  typeof process === "undefined" ? undefined : process.getBuiltinModule("node:async_hooks");
const detachedAsyncContext = asyncHooks
  ? resolveGlobalSingleton(
      Symbol.for("openclaw.detachedAsyncContext"),
      () => new asyncHooks.AsyncResource("openclaw.detached-async-context"),
    )
  : undefined;

/** Runs under the context-free async root initialized before managed work can begin. */
export function runInDetachedAsyncContext<T>(run: () => T): T {
  return detachedAsyncContext ? detachedAsyncContext.runInAsyncScope(run) : run();
}
