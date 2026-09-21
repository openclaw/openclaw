import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { registerNodeSqliteDisposeCallback } from "../infra/kysely-sync-cache-state.js";
import { isPathInside } from "../infra/path-guards.js";
import { stageSqliteTransactionState } from "../infra/sqlite-post-commit.js";
import { readSqliteUserVersion } from "../infra/sqlite-user-version.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { hasPersistedOpenClawAgentCanonicalValidation } from "./openclaw-agent-canonical-validation-receipt.js";
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

// Ordinary close retains proof. Durable canonical receipts never mint integrity
// verification; only a successful writable open supplies proof workers can borrow.
const validatedPaths = resolveGlobalSingleton<
  Map<string, { validation: OpenClawAgentDatabaseValidation; integrityVerified: boolean } | null>
>(
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
  const unregister = registerNodeSqliteDisposeCallback(database.db, (reason) => {
    if (reason === "replace") {
      Atomics.store(new Int32Array(validation.valid), 0, 0);
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

function hasRevokedValidation(pathname: string): boolean {
  const previous = validatedPaths.get(path.resolve(pathname));
  return (
    previous === null ||
    (previous !== undefined && Atomics.load(new Int32Array(previous.validation.valid), 0) !== 1)
  );
}

export function getOpenClawAgentDatabaseValidation(
  database: ValidationDatabase,
): OpenClawAgentDatabaseValidation | undefined {
  const entry = validatedPaths.get(path.resolve(database.path));
  if (!entry?.integrityVerified || !matchesValidation(database, entry.validation)) {
    return undefined;
  }
  const validation = entry.validation;
  bindValidationLifetime(database, validation);
  return validation;
}

/** The receiving opener must adopt this proof against its own physical file identity. */
export function getOpenClawAgentDatabaseValidationForTransfer(
  database: Pick<ValidationDatabase, "agentId" | "path">,
): OpenClawAgentDatabaseValidation | undefined {
  const entry = validatedPaths.get(path.resolve(database.path));
  if (
    !entry?.integrityVerified ||
    entry.validation.agentId !== database.agentId ||
    Atomics.load(new Int32Array(entry.validation.valid), 0) !== 1
  ) {
    return undefined;
  }
  return entry.validation;
}

function canonicalValidationReceipt(
  database: CanonicalValidationDatabase,
): OpenClawAgentDatabaseValidation | undefined {
  if (!database.db.isOpen || !findOpenClawAgentDatabaseIdentity(database)) {
    return undefined;
  }
  const pathname = database.path ?? database.db.location();
  if (!pathname) {
    return undefined;
  }
  const validation = validatedPaths.get(path.resolve(pathname))?.validation;
  if (!validation || !matchesValidation({ ...database, path: pathname }, validation)) {
    return undefined;
  }
  bindValidationLifetime({ ...database, path: pathname }, validation);
  return validation;
}

/** A clean pending table needs proof from this admitted physical generation. */
export function hasOpenClawAgentCanonicalValidation(
  database: CanonicalValidationDatabase,
): boolean {
  const validation = canonicalValidationReceipt(database);
  if (validation) {
    return (
      Atomics.load(new Int32Array(validation.canonicalReady), 0) === 1 &&
      Atomics.load(new Int32Array(validation.valid), 0) === 1
    );
  }
  const pathname = database.path ?? findOpenClawAgentDatabaseIdentity(database)?.filename;
  if (
    !pathname ||
    database.db.isTransaction ||
    validatedPaths.has(path.resolve(pathname)) ||
    !hasPersistedOpenClawAgentCanonicalValidation(database)
  ) {
    return false;
  }
  const canonical = createValidationReceipt({ ...database, path: pathname }, true);
  validatedPaths.set(path.resolve(pathname), { validation: canonical, integrityVerified: false });
  bindValidationLifetime({ ...database, path: pathname }, canonical);
  return true;
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
  if (hasRevokedValidation(database.path)) {
    // Integrity handoff cannot replace the parent's requested canonical certification.
    Atomics.store(new Int32Array(validation.canonicalReady), 0, 0);
  }
  invalidateOpenClawAgentDatabaseValidation(database.path);
  validatedPaths.set(path.resolve(database.path), { validation, integrityVerified: true });
  bindValidationLifetime(database, validation);
  return true;
}

function isOpenClawAgentCanonicalStoreEmpty(database: { db: DatabaseSync }): boolean {
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

function createValidationReceipt(
  database: ValidationDatabase,
  canonicalReady: boolean,
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
  if (canonicalReady) {
    Atomics.store(new Int32Array(validation.canonicalReady), 0, 1);
  }
  Atomics.store(new Int32Array(validation.valid), 0, 1);
  return validation;
}

export function setOpenClawAgentDatabaseValidation(
  database: ValidationDatabase,
): OpenClawAgentDatabaseValidation {
  const revoked = hasRevokedValidation(database.path);
  const validation = createValidationReceipt(
    database,
    isOpenClawAgentCanonicalStoreEmpty(database) ||
      (!revoked &&
        !database.db.isTransaction &&
        hasPersistedOpenClawAgentCanonicalValidation(database)),
  );
  invalidateOpenClawAgentDatabaseValidation(database.path);
  validatedPaths.set(path.resolve(database.path), { validation, integrityVerified: true });
  bindValidationLifetime(database, validation);
  return validation;
}

export function invalidateOpenClawAgentDatabaseValidation(pathname: string): void {
  const resolved = path.resolve(pathname);
  const validation = validatedPaths.get(resolved)?.validation;
  if (validation) {
    Atomics.store(new Int32Array(validation.valid), 0, 0);
  } else {
    // Revocation can precede the first in-process read of a durable receipt.
    validatedPaths.set(resolved, null);
  }
}

export function invalidateOpenClawAgentDatabaseValidationsForAgent(
  agentId: string,
  removedPaths: readonly string[],
): void {
  for (const pathname of removedPaths) {
    invalidateOpenClawAgentDatabaseValidation(pathname);
  }
  for (const [pathname, entry] of validatedPaths) {
    if (entry?.validation.agentId === agentId) {
      invalidateOpenClawAgentDatabaseValidation(pathname);
    }
  }
}

export function clearOpenClawAgentDatabaseValidationCache(rootPath?: string): void {
  for (const pathname of validatedPaths.keys()) {
    if (rootPath === undefined || isPathInside(rootPath, pathname)) {
      invalidateOpenClawAgentDatabaseValidation(pathname);
      validatedPaths.delete(pathname);
    }
  }
}
