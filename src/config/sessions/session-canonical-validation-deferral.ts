import type { DatabaseSync } from "node:sqlite";
import { isPromiseLike } from "@openclaw/normalization-core/promise-like";
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";

type PendingCanonicalValidation = { agentId: string; path: string };
type ValidationDeferralScope = { pending?: PendingCanonicalValidation };

// The scope is synchronous: restoring the previous frame precedes every await,
// including when a resolver catches the private signal and returns an error shape.
const deferral = resolveGlobalSingleton<{ current?: ValidationDeferralScope }>(
  Symbol.for("openclaw.canonicalSessionValidationDeferral"),
  () => ({}),
);

class CanonicalSessionValidationDeferred extends Error {
  constructor() {
    super("Canonical session validation requires asynchronous readiness");
  }
}

/** Only initial asynchronous admission may defer; committed mutation guards stay synchronous. */
export function deferCanonicalSessionValidation(database: {
  agentId: string;
  db: DatabaseSync;
}): void {
  const scope = deferral.current;
  if (!scope) {
    return;
  }
  const pathname = database.db.location();
  if (!pathname) {
    return;
  }
  scope.pending ??= { agentId: database.agentId, path: pathname };
  throw new CanonicalSessionValidationDeferred();
}

export function withCanonicalSessionValidationDeferral<T>(
  read: () => T,
): { kind: "complete"; value: T } | { kind: "pending"; database: PendingCanonicalValidation } {
  const previous = deferral.current;
  const scope: ValidationDeferralScope = {};
  let asynchronousResult = false;
  deferral.current = scope;
  try {
    const value = read();
    if (isPromiseLike(value)) {
      asynchronousResult = true;
      void Promise.resolve(value).catch(() => {});
      throw new Error("Canonical session validation deferral callbacks must remain synchronous");
    }
    if (scope.pending) {
      return { kind: "pending", database: scope.pending };
    }
    return { kind: "complete", value };
  } catch (error) {
    if (scope.pending && !asynchronousResult) {
      return { kind: "pending", database: scope.pending };
    }
    throw error;
  } finally {
    deferral.current = previous;
  }
}
