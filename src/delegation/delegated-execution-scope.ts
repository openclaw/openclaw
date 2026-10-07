/**
 * Host-owned delegated execution scope.
 *
 * The Host runs delegated work inside this asynchronous scope so every nested
 * execution inherits the delegated lineage without extra plumbing. Only Host
 * code can enter the scope: the value is a lineage reference taken from a
 * Host-minted delegation binding, never a plain id or a caller-supplied string.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";

const DELEGATED_EXECUTION_SCOPE_KEY: unique symbol = Symbol.for("openclaw.delegatedExecutionScope");

const delegatedExecutionScope = resolveGlobalSingleton<AsyncLocalStorage<string>>(
  DELEGATED_EXECUTION_SCOPE_KEY,
  () => new AsyncLocalStorage<string>(),
);

/** Runs delegated work inside the Host-owned lineage scope. */
export function runWithDelegatedExecutionLineage<T>(lineageRef: string, run: () => T): T {
  if (typeof lineageRef !== "string" || lineageRef.length === 0) {
    throw new Error("delegated execution scope requires a non-empty lineage reference");
  }
  return delegatedExecutionScope.run(lineageRef, run);
}

/** The delegated lineage covering the current Host execution, if any. */
export function readCurrentDelegatedExecutionLineage(): string | undefined {
  const value = delegatedExecutionScope.getStore();
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
