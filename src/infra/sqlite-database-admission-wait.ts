// Leaf scope: admission and lock primitives read it without importing the worker relay.
import { AsyncLocalStorage } from "node:async_hooks";
import { isPromise } from "node:util/types";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { wrapSqliteWorkerError } from "./sqlite-worker-error.js";

type AdmissionWait = {
  readonly deadlineAtMs?: number;
  assertActive?: () => void;
  /** Outer cancellation stops here; outer deadlines still apply. */
  settlesCancellation?: true;
};
type AdmissionWaitScope = { wait: AdmissionWait; parent?: AdmissionWaitScope; active: boolean };
const admissionWait = resolveGlobalSingleton(
  Symbol.for("openclaw.sqliteDatabaseAdmissionWait"),
  () => new AsyncLocalStorage<AdmissionWaitScope>(),
);

/** Callers own the deadline; worker transports carry its remaining absolute budget. */
export function withSqliteDatabaseAdmissionWait<T>(wait: AdmissionWait, run: () => T): T {
  const scope = { wait, parent: admissionWait.getStore(), active: true };
  const close = () => {
    scope.active = false;
  };
  let pending = false;
  try {
    const value = admissionWait.run(scope, run);
    if (isPromise(value)) {
      pending = true;
      void value.then(close, close);
    }
    return value;
  } finally {
    if (!pending) {
      close();
    }
  }
}

/** Releasing or retiring cancelled work must finish; only its deadline still bounds the wait. */
export function withSqliteDatabaseAdmissionSettlement<T>(run: () => T): T {
  return withSqliteDatabaseAdmissionWait({ settlesCancellation: true }, run);
}

export function readSqliteDatabaseAdmissionDeadline(): number | undefined {
  let deadline: number | undefined;
  for (let scope = admissionWait.getStore(); scope; scope = scope.parent) {
    // Retained worker callbacks keep async ancestry, but never a settled caller's budget.
    if (!scope.active) {
      continue;
    }
    const value = scope.wait.deadlineAtMs;
    if (value !== undefined) {
      deadline = Math.min(deadline ?? Infinity, value);
    }
  }
  return deadline;
}

export function assertSqliteDatabaseAdmissionWaitActive(): void {
  try {
    for (let scope = admissionWait.getStore(); scope; scope = scope.parent) {
      if (!scope.active) {
        continue;
      }
      if (scope.wait.settlesCancellation) {
        return;
      }
      scope.wait.assertActive?.();
    }
  } catch (error) {
    throw wrapSqliteWorkerError(
      "SQLite admission facts exchange cancelled by its caller",
      "unavailable",
      error,
    );
  }
}

export function hasSqliteDatabaseAdmissionWait(): boolean {
  return admissionWait.getStore() !== undefined;
}
