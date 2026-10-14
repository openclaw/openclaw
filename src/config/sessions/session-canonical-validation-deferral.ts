import type { DatabaseSync } from "node:sqlite";
import { isPromiseLike } from "@openclaw/normalization-core/promise-like";
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";
import type { OpenClawAgentDatabaseOptions } from "../../state/openclaw-agent-db-contract.js";
import { readOpenClawAgentDatabaseIdentity } from "../../state/openclaw-agent-db-identity.js";
import { captureOpenClawStateReadWorkerContext } from "../../state/openclaw-state-worker-context.js";

export type PendingCanonicalValidation = OpenClawAgentDatabaseOptions & {
  agentId: string;
  path: string;
  initializeCanonicalValidation: boolean;
  assertStateCurrent: () => void;
  source: { key: string; canonicalPath: string; birthtime?: string; incarnation: string };
};
type ValidationDeferralScope = { env: NodeJS.ProcessEnv; pending?: PendingCanonicalValidation };

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
export function deferCanonicalSessionValidation(
  database: { agentId: string; db: DatabaseSync },
  initializeCanonicalValidation: boolean,
): void {
  const scope = deferral.current;
  if (!scope) {
    return;
  }
  const pathname = database.db.location();
  if (!pathname) {
    return;
  }
  const source = readOpenClawAgentDatabaseIdentity(database);
  if (typeof source.identity !== "string") {
    return;
  }
  const state = captureOpenClawStateReadWorkerContext({ env: scope.env });
  scope.pending ??= {
    env: state.environment,
    assertStateCurrent: state.admission.assertCurrent,
    agentId: database.agentId,
    path: pathname,
    initializeCanonicalValidation,
    source: {
      key: `file:${source.identity}`,
      canonicalPath: source.canonicalPath,
      birthtime: source.birthtime,
      incarnation: source.incarnation,
    },
  };
  throw new CanonicalSessionValidationDeferred();
}

export function withCanonicalSessionValidationDeferral<T>(
  read: () => T,
  env: NodeJS.ProcessEnv = process.env,
): { kind: "complete"; value: T } | { kind: "pending"; database: PendingCanonicalValidation } {
  const previous = deferral.current;
  const scope: ValidationDeferralScope = { env };
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
