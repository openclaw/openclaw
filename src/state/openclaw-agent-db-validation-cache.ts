import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { registerNodeSqliteDisposeCallback } from "../infra/kysely-sync-cache-state.js";
import { isPathInside } from "../infra/path-guards.js";
import { stageSqliteTransactionState } from "../infra/sqlite-post-commit.js";
import { readSqliteUserVersion } from "../infra/sqlite-user-version.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { assertCanonicalSessionValidationSchema } from "./openclaw-agent-canonical-validation-schema.js";
import { CANONICAL_SESSION_VALIDATION_SCHEMA_VERSION } from "./openclaw-agent-db-contract.js";
import {
  findOpenClawAgentDatabaseIdentity,
  readOpenClawAgentDatabaseIdentity,
} from "./openclaw-agent-db-identity.js";

export type OpenClawAgentDatabaseValidation = {
  agentId: string;
  identity: string;
  /** Shared with admitted workers so owner invalidation revokes borrowed proof. */
  valid: SharedArrayBuffer;
  /** First full canonical proof; subsequent changes remain visible through the pending table. */
  canonicalReady: SharedArrayBuffer;
};
type ValidationDatabase = { db: DatabaseSync; path: string; agentId: string };
type CanonicalValidationDatabase = { db: DatabaseSync; path?: string; agentId: string };

// Ordinary close and eviction retain proof for this Gateway lifetime. Only a
// successful canonical open can create it; workers borrow it under admission.
const validatedPaths = resolveGlobalSingleton<Map<string, OpenClawAgentDatabaseValidation>>(
  Symbol.for("openclaw.agentDatabaseValidatedPaths"),
  () => new Map(),
  () => clearOpenClawAgentDatabaseValidationCache(),
);
const validationBindings = resolveGlobalSingleton(
  Symbol.for("openclaw.agentDatabaseValidationBindings"),
  () =>
    new WeakMap<
      DatabaseSync,
      { validation: OpenClawAgentDatabaseValidation; unregister: () => void }
    >(),
);

function bindValidationLifetime(
  database: ValidationDatabase,
  validation: OpenClawAgentDatabaseValidation,
): void {
  const current = validationBindings.get(database.db);
  if (!database.db.isOpen || current?.validation === validation) {
    return;
  }
  current?.unregister();
  const pathname = path.resolve(database.path);
  const unregister = registerNodeSqliteDisposeCallback(database.db, (reason) => {
    if (reason === "replace") {
      Atomics.store(new Int32Array(validation.valid), 0, 0);
      if (validatedPaths.get(pathname) === validation) {
        validatedPaths.delete(pathname);
      }
    }
    validationBindings.delete(database.db);
    unregister();
  });
  validationBindings.set(database.db, { validation, unregister });
}

function matchesValidation(
  database: ValidationDatabase,
  validation: OpenClawAgentDatabaseValidation,
): boolean {
  return (
    validation.agentId === database.agentId &&
    validation.identity === findOpenClawAgentDatabaseIdentity(database)?.identity &&
    Atomics.load(new Int32Array(validation.valid), 0) === 1
  );
}

export function getOpenClawAgentDatabaseValidation(
  database: ValidationDatabase,
): OpenClawAgentDatabaseValidation | undefined {
  const validation = validatedPaths.get(path.resolve(database.path));
  if (!validation || !matchesValidation(database, validation)) {
    return undefined;
  }
  bindValidationLifetime(database, validation);
  return validation;
}

function canonicalValidationReceipt(
  database: CanonicalValidationDatabase,
): OpenClawAgentDatabaseValidation | undefined {
  if (!database.db.isOpen || !findOpenClawAgentDatabaseIdentity(database)) {
    return undefined;
  }
  const pathname = database.path ?? database.db.location();
  return pathname ? getOpenClawAgentDatabaseValidation({ ...database, path: pathname }) : undefined;
}

/** A copied clean pending table cannot replace the admitted physical owner's first full proof. */
export function hasOpenClawAgentCanonicalValidation(
  database: CanonicalValidationDatabase,
): boolean {
  const validation = canonicalValidationReceipt(database);
  return (
    validation !== undefined &&
    Atomics.load(new Int32Array(validation.canonicalReady), 0) === 1 &&
    Atomics.load(new Int32Array(validation.valid), 0) === 1
  );
}

/** Publish successful canonical proof only when its outer transaction has committed. */
export function markOpenClawAgentCanonicalValidation(
  database: CanonicalValidationDatabase,
): boolean {
  const validation = canonicalValidationReceipt(database);
  if (!validation) {
    return false;
  }
  const publish = () => {
    if (Atomics.load(new Int32Array(validation.valid), 0) === 1) {
      Atomics.store(new Int32Array(validation.canonicalReady), 0, 1);
    }
  };
  if (database.db.isTransaction) {
    return stageSqliteTransactionState(database.db, {
      stage: () => {},
      rollback: () => {},
      commit: publish,
    });
  }
  publish();
  return Atomics.load(new Int32Array(validation.valid), 0) === 1;
}

export function adoptOpenClawAgentDatabaseValidation(
  database: ValidationDatabase,
  validation: OpenClawAgentDatabaseValidation,
): boolean {
  if (!matchesValidation(database, validation)) {
    return false;
  }
  // A concurrent first opener can return another healthy receipt. Keep the
  // owner's existing revocation cell shared by workers already borrowing it.
  if (getOpenClawAgentDatabaseValidation(database)) {
    return true;
  }
  invalidateOpenClawAgentDatabaseValidation(database.path);
  validatedPaths.set(path.resolve(database.path), validation);
  bindValidationLifetime(database, validation);
  return true;
}

function hasEmptyVerifiedCanonicalStore(database: ValidationDatabase): boolean {
  if (
    database.db.isTransaction ||
    readSqliteUserVersion(database.db) < CANONICAL_SESSION_VALIDATION_SCHEMA_VERSION
  ) {
    return false;
  }
  assertCanonicalSessionValidationSchema(database.db);
  return (
    // sqlite-allow-raw -- One admission snapshot proves an empty verified store without reading payloads.
    database.db
      .prepare(`SELECT
    EXISTS(SELECT 1 FROM session_nodes) OR
    EXISTS(SELECT 1 FROM session_canonical_validation_pending) AS populated`)
      .get()?.populated === 0
  );
}

export function setOpenClawAgentDatabaseValidation(
  database: ValidationDatabase,
): OpenClawAgentDatabaseValidation {
  const { identity } = readOpenClawAgentDatabaseIdentity(database);
  if (typeof identity !== "string") {
    throw new Error("Only persistent agent databases retain integrity validation");
  }
  const validation = {
    agentId: database.agentId,
    identity,
    valid: new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT),
    canonicalReady: new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT),
  };
  if (hasEmptyVerifiedCanonicalStore(database)) {
    Atomics.store(new Int32Array(validation.canonicalReady), 0, 1);
  }
  Atomics.store(new Int32Array(validation.valid), 0, 1);
  invalidateOpenClawAgentDatabaseValidation(database.path);
  validatedPaths.set(path.resolve(database.path), validation);
  bindValidationLifetime(database, validation);
  return validation;
}

export function invalidateOpenClawAgentDatabaseValidation(pathname: string): void {
  const resolved = path.resolve(pathname);
  const validation = validatedPaths.get(resolved);
  if (validation) {
    Atomics.store(new Int32Array(validation.valid), 0, 0);
    validatedPaths.delete(resolved);
  }
}

export function invalidateOpenClawAgentDatabaseValidationsForAgent(agentId: string): void {
  for (const [pathname, validation] of validatedPaths) {
    if (validation.agentId === agentId) {
      invalidateOpenClawAgentDatabaseValidation(pathname);
    }
  }
}

export function clearOpenClawAgentDatabaseValidationCache(rootPath?: string): void {
  for (const pathname of validatedPaths.keys()) {
    if (rootPath === undefined || isPathInside(rootPath, pathname)) {
      invalidateOpenClawAgentDatabaseValidation(pathname);
    }
  }
}
