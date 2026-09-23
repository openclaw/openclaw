import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
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
type ValidationEntry = {
  agentId?: string;
  validation?: OpenClawAgentDatabaseValidation;
  integrityVerified: boolean;
  revoked?: true;
};

// Ordinary close retains proof. Durable canonical receipts never mint integrity
// verification; only a successful writable open supplies proof workers can borrow.
const validatedPaths = resolveGlobalSingleton<Map<string, ValidationEntry>>(
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
    previous?.revoked === true ||
    (previous?.validation !== undefined &&
      Atomics.load(new Int32Array(previous.validation.valid), 0) !== 1)
  );
}

export function getOpenClawAgentDatabaseValidation(
  database: ValidationDatabase,
): OpenClawAgentDatabaseValidation | undefined {
  const entry = validatedPaths.get(path.resolve(database.path));
  if (
    !entry?.integrityVerified ||
    !entry.validation ||
    !matchesValidation(database, entry.validation)
  ) {
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
    !entry.validation ||
    entry.validation.agentId !== database.agentId ||
    Atomics.load(new Int32Array(entry.validation.valid), 0) !== 1
  ) {
    return undefined;
  }
  return entry.validation;
}

/** Native admission supplies the checked file identity; no host SQLite handle is needed. */
export function captureOpenClawAgentDatabaseValidationTransfer(
  database: Pick<ValidationDatabase, "agentId" | "path">,
): (identity: string, received: unknown) => boolean {
  const pathname = path.resolve(database.path);
  const existing = validatedPaths.get(pathname);
  const captured: ValidationEntry =
    existing?.agentId === database.agentId
      ? existing
      : {
          ...existing,
          agentId: database.agentId,
          integrityVerified: existing?.integrityVerified ?? false,
        };
  validatedPaths.set(pathname, captured);
  const capturedValidation = captured.validation;
  const wasValid = capturedValidation
    ? Atomics.load(new Int32Array(capturedValidation.valid), 0)
    : undefined;
  return (identity, received) => {
    if (
      validatedPaths.get(pathname) !== captured ||
      (capturedValidation &&
        wasValid === 1 &&
        Atomics.load(new Int32Array(capturedValidation.valid), 0) !== 1) ||
      !isRecord(received) ||
      received.agentId !== database.agentId ||
      received.identity !== identity ||
      !(received.valid instanceof SharedArrayBuffer) ||
      received.valid.byteLength !== Int32Array.BYTES_PER_ELEMENT ||
      Atomics.load(new Int32Array(received.valid), 0) !== 1 ||
      !(received.canonicalReady instanceof SharedArrayBuffer) ||
      received.canonicalReady.byteLength !== Int32Array.BYTES_PER_ELEMENT
    ) {
      return false;
    }
    if (
      wasValid === 1 &&
      captured.integrityVerified &&
      captured.validation?.agentId === database.agentId &&
      captured.validation?.identity === identity
    ) {
      return true;
    }
    const validation = {
      agentId: database.agentId,
      identity,
      valid: received.valid,
      canonicalReady: received.canonicalReady,
    };
    if (hasRevokedValidation(pathname)) {
      Atomics.store(new Int32Array(validation.canonicalReady), 0, 0);
    }
    invalidateOpenClawAgentDatabaseValidation(pathname);
    validatedPaths.set(pathname, { validation, integrityVerified: true });
    return true;
  };
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
    validatedPaths.get(path.resolve(pathname))?.validation !== undefined ||
    hasRevokedValidation(pathname) ||
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

export function invalidateOpenClawAgentDatabaseValidation(
  pathname: string,
  identity = validatedPaths.get(path.resolve(pathname))?.validation?.identity,
): void {
  const resolved = path.resolve(pathname);
  const paths = new Set([resolved]);
  if (identity) {
    for (const [candidate, entry] of validatedPaths) {
      if (entry.validation?.identity === identity) {
        paths.add(candidate);
      }
    }
  }
  for (const candidate of paths) {
    const entry = validatedPaths.get(candidate);
    const validation = entry?.validation;
    if (validation) {
      Atomics.store(new Int32Array(validation.valid), 0, 0);
    }
    // Replace even an empty/revoked entry so an in-flight handoff cannot revive it.
    validatedPaths.set(candidate, {
      agentId: entry?.agentId,
      validation,
      integrityVerified: false,
      revoked: true,
    });
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
    if (entry.validation?.agentId === agentId || entry.agentId === agentId) {
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
