import type { DatabaseSync } from "node:sqlite";
import { registerNodeSqliteDisposeCallback } from "../infra/kysely-sync-cache-state.js";
import {
  getSqliteDatabaseAdmission,
  publishSqliteDatabaseAdmission,
  revokeSqliteDatabaseAdmissions,
  type SqliteDatabaseAdmissionKey,
} from "../infra/sqlite-database-admission.js";
import { assertSqliteIntegrity } from "../infra/sqlite-integrity.js";
import { stageSqliteTransactionState } from "../infra/sqlite-post-commit.js";
import { registerSqliteSchemaMutationListener } from "../infra/sqlite-schema-facts.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { getStateRuntimeSchemaAdmission } from "./openclaw-state-db-admission.js";
import type { OpenClawStateIntegrityAdmission } from "./openclaw-state-db-async-lifecycle.js";
import { readTrackedStateDatabaseIdentity } from "./openclaw-state-db-handle.js";

const bindings = resolveGlobalSingleton(
  Symbol.for("openclaw.stateIntegrityBindings"),
  () => new WeakMap<DatabaseSync, { revision: SharedArrayBuffer; release(): void }>(),
);

export type OpenClawStateIntegrityPolicy = "verify" | "require-proof";

const integrityKey: SqliteDatabaseAdmissionKey<true> = {
  name: "state.integrity",
  read: (value) => (value === true ? true : undefined),
};

function hasStateDatabaseIntegrityAdmission(database: DatabaseSync): boolean {
  return Boolean(
    getStateRuntimeSchemaAdmission(database) || getSqliteDatabaseAdmission(database, integrityKey),
  );
}

/** Ordinary opens share physical-file proof; Doctor calls the uncached integrity owner. */
export function assertStateDatabaseIntegrityOnce(database: DatabaseSync, pathname: string): void {
  if (!hasStateDatabaseIntegrityAdmission(database)) {
    assertSqliteIntegrity(database, pathname);
    publishSqliteDatabaseAdmission(database, integrityKey, true);
  }
}

function invalidate(revision: BigInt64Array): void {
  let previous = Atomics.load(revision, 0);
  while (previous >= 0n) {
    const observed = Atomics.compareExchange(revision, 0, previous, previous + 1n);
    if (observed === previous) {
      return;
    }
    previous = observed;
  }
}

/** Corruption observed in an isolate revokes the exact host proof borrowed by its native handle. */
export function invalidateOpenClawStateRuntimeIntegrity(database: DatabaseSync): void {
  revokeSqliteDatabaseAdmissions(database);
  const bound = bindings.get(database);
  if (bound) {
    invalidate(new BigInt64Array(bound.revision));
  }
}

/** Native bindings revoke borrowed proof; the host generation alone owns its lifetime. */
function bind(database: DatabaseSync, admission: OpenClawStateIntegrityAdmission): void {
  if (bindings.get(database)?.revision === admission.revision) {
    return;
  }
  bindings.get(database)?.release();
  const revision = new BigInt64Array(admission.revision);
  const unobserve = registerSqliteSchemaMutationListener(database, () => invalidate(revision));
  const release = () => {
    unobserve();
    unregister();
    // Failed rollback can close before its corruption reaches the owner; retain the receipt until GC.
  };
  const unregister = registerNodeSqliteDisposeCallback(database, (reason) => {
    if (reason === "replace") {
      invalidate(revision);
    }
    release();
  });
  bindings.set(database, { revision: admission.revision, release });
}

/** Reuse only completed integrity proof; shape and mutable metadata retain their admission owners. */
export function assertOpenClawStateRuntimeIntegrity(
  database: DatabaseSync,
  pathname: string,
  schema: { schemaVersion: number; userVersion: number },
  admission?: OpenClawStateIntegrityAdmission,
  policy: OpenClawStateIntegrityPolicy = "verify",
): (() => void) | undefined {
  const identity = admission && readTrackedStateDatabaseIdentity(database);
  if (
    !admission ||
    !identity ||
    !identity.key.startsWith("file:") ||
    identity.key !== admission.identity.key ||
    identity.birthtime !== admission.identity.birthtime
  ) {
    if (policy === "require-proof") {
      throw new Error("Shared-state reader requires current worker integrity proof");
    }
    assertStateDatabaseIntegrityOnce(database, pathname);
    return undefined;
  }
  bind(database, admission);
  const revision = new BigInt64Array(admission.revision);
  const proof = new BigInt64Array(admission.proof);
  const metadata = BigInt.asIntN(
    64,
    (BigInt(schema.userVersion >>> 0) << 32n) | BigInt(schema.schemaVersion >>> 0),
  );
  const observed = Atomics.load(proof, 0);
  if (Atomics.load(revision, 0) === admission.epoch && observed !== -1n) {
    if (
      observed === metadata &&
      Atomics.load(revision, 0) === admission.epoch &&
      hasStateDatabaseIntegrityAdmission(database)
    ) {
      return undefined;
    }
    invalidate(revision);
  }
  if (policy === "require-proof") {
    throw new Error("Shared-state reader requires current worker integrity proof");
  }
  assertStateDatabaseIntegrityOnce(database, pathname);
  const publish = () => {
    if (Atomics.load(revision, 0) === admission.epoch) {
      Atomics.store(proof, 0, metadata);
    }
  };
  return () => {
    if (database.isTransaction) {
      stageSqliteTransactionState(database, { stage() {}, rollback() {}, commit: publish });
    } else {
      publish();
    }
  };
}
