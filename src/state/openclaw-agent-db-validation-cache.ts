import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { registerNodeSqliteDisposeCallback } from "../infra/kysely-sync-cache-state.js";
import { observeOwnedDirectory } from "../infra/owned-directory-observation.js";
import { isPathInside } from "../infra/path-guards.js";
import { sqlPublicationAnchor, type EngineConnection } from "../infra/sql-connection.js";
import {
  getSqliteDatabaseAdmission,
  publishSqliteDatabaseAdmission,
} from "../infra/sqlite-database-admission.js";
import { stageSqliteTransactionState } from "../infra/sqlite-post-commit.js";
import { registerSqliteSchemaMutationListener } from "../infra/sqlite-schema-facts.js";
import {
  assertExistingDatabaseIdentity,
  readDatabasePathIdentitySync,
  resolveDatabasePathKey,
} from "../infra/sqlite-worker-identity.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import {
  AgentDatabaseSchemaAdmissionChangedError,
  AgentDatabaseSchemaAdmissionInvalidError,
} from "./agent-database-admission-error.js";
import {
  clearPersistedOpenClawAgentCanonicalValidation,
  hasPersistedOpenClawAgentCanonicalValidation,
  loadOpenClawAgentCanonicalValidationReceipt,
} from "./openclaw-agent-canonical-validation-receipt.js";
import { assertCanonicalSessionValidationSchema } from "./openclaw-agent-canonical-validation-schema.js";
import { CANONICAL_SESSION_VALIDATION_SCHEMA_VERSION } from "./openclaw-agent-db-contract.js";
import {
  findOpenClawAgentDatabaseIdentity,
  readOpenClawAgentDatabaseIdentity,
} from "./openclaw-agent-db-identity.js";
import {
  matchesAgentDatabaseReadCandidatePath,
  type OpenClawAgentDatabaseReadCandidateResource,
} from "./openclaw-agent-db-resources.js";
import { readAgentDatabaseSchemaVersion } from "./openclaw-agent-db-schema-read.js";
import {
  agentDatabaseValidationKey,
  createOpenClawAgentDatabaseValidationReceipt,
  matchesAgentDatabaseValidation as matchesValidation,
  type OpenClawAgentDatabaseValidation,
} from "./openclaw-agent-db-validation-facts.js";
import {
  adoptAgentValidationSchema,
  matchesValidationSchema,
  publishAgentValidationSchema,
} from "./openclaw-agent-db-validation-schema.js";

export type { OpenClawAgentDatabaseValidation } from "./openclaw-agent-db-validation-facts.js";

export type OpenClawAgentDatabaseReadValidation = Omit<OpenClawAgentDatabaseValidation, "schema">;
type ValidationDatabase = { db: EngineConnection; path: string; agentId: string };
type CanonicalValidationDatabase = { db: EngineConnection; path?: string; agentId: string };
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
const validationObservations = resolveGlobalSingleton<
  Map<string, { close(): void; revalidate(): void }>
>(Symbol.for("openclaw.agentDatabaseValidationObservations"), () => new Map());

function releaseValidationObservation(pathname: string): void {
  validationObservations.get(pathname)?.close();
}

function observeValidationPath(pathname: string, admission: boolean): void {
  const existing = validationObservations.get(pathname);
  if (existing) {
    if (admission) {
      existing.revalidate();
    }
    return;
  }
  const revalidate = () => {
    const validation = validatedPaths.get(pathname)?.validation;
    if (!validation || Atomics.load(new Int32Array(validation.valid), 0) !== 1) {
      return;
    }
    try {
      assertExistingDatabaseIdentity(pathname, `file:${validation.identity}`, validation.birthtime);
    } catch {
      invalidateOpenClawAgentDatabaseValidation(pathname, validation.identity);
    }
  };
  const watched = observeOwnedDirectory(
    path.dirname(pathname),
    (filename) => {
      if (
        filename === undefined ||
        (process.platform === "win32"
          ? filename.toLowerCase() === path.basename(pathname).toLowerCase()
          : filename === path.basename(pathname))
      ) {
        revalidate();
      }
    },
    { recoveryIntervalMs: 30_000 },
  );
  // Retained proof outlives native handles; its cache owns observation cleanup.
  validationObservations.set(pathname, {
    revalidate,
    close() {
      watched.close();
      validationObservations.delete(pathname);
    },
  });
  // The first subscriber must not retain a file replaced before observation began.
  revalidate();
}

const validationBindings = resolveGlobalSingleton(
  Symbol.for("openclaw.agentDatabaseValidationBindings"),
  () =>
    new WeakMap<
      EngineConnection,
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
  const key = readOpenClawAgentDatabaseIdentity(database).canonicalPath;
  const anchor = sqlPublicationAnchor(database.db);
  const unobserve = registerSqliteSchemaMutationListener(anchor, (observed) => {
    const revoke = (schema: OpenClawAgentDatabaseValidation["schema"]) => {
      // A late reader can observe DDL already covered by a newer admitted receipt.
      // Local pre-mutation notifications have no markers and still revoke every receipt.
      if (
        schema &&
        (!observed ||
          schema.postgres ||
          schema.facts.schemaVersion !== observed.schemaVersion ||
          schema.facts.userVersion !== observed.userVersion)
      ) {
        Atomics.store(new Int32Array(schema.valid), 0, 0);
      }
    };
    revoke(validation.schema);
    // A retained alias can mutate after another opener replaced its receipt.
    const published = validatedPaths.get(key)?.validation;
    if (
      published?.schema &&
      published.agentId === validation.agentId &&
      published.identity === validation.identity
    ) {
      revoke(published.schema);
    }
  });
  const unregister = registerNodeSqliteDisposeCallback(anchor, (reason) => {
    if (reason === "replace") {
      Atomics.store(new Int32Array(validation.valid), 0, 0);
    }
    validationBindings.delete(database.db);
    unobserve();
    unregister();
  });
  validationBindings.set(database.db, {
    validation,
    unregister: () => {
      unobserve();
      unregister();
    },
  });
}

/** Revocation precedes schema inspection so siblings cannot borrow the superseded revision. */
export function invalidateOpenClawAgentDatabaseSchema(database: ValidationDatabase): void {
  const schema = getOpenClawAgentDatabaseValidation(database)?.schema;
  if (schema) {
    Atomics.store(new Int32Array(schema.valid), 0, 0);
  }
}

/** Consume only a live physical owner's schema proof at connection admission. */
export function adoptOpenClawAgentDatabaseSchema(
  database: ValidationDatabase,
  reuseIntegrity = true,
  required = false,
): boolean {
  return adoptAgentValidationSchema(
    database,
    getOpenClawAgentDatabaseValidation(database),
    reuseIntegrity,
    required,
  );
}

export function hasRevokedOpenClawAgentDatabaseValidation(
  pathname: string,
  received?: OpenClawAgentDatabaseValidation,
): boolean {
  const previous = validatedPaths.get(resolveDatabasePathKey(pathname));
  return (
    (received !== undefined && Atomics.load(new Int32Array(received.valid), 0) !== 1) ||
    previous?.revoked === true ||
    (previous?.validation !== undefined &&
      Atomics.load(new Int32Array(previous.validation.valid), 0) !== 1)
  );
}

export function getOpenClawAgentDatabaseValidation(
  database: ValidationDatabase,
): OpenClawAgentDatabaseValidation | undefined {
  const pathname = readOpenClawAgentDatabaseIdentity(database).canonicalPath;
  let entry = validatedPaths.get(pathname);
  // Shared physical facts cannot undo a refusal by this path's admission owner.
  if (entry?.revoked) {
    return undefined;
  }
  if (
    !entry?.integrityVerified ||
    !entry.validation ||
    (entry.validation.schema &&
      Atomics.load(new Int32Array(entry.validation.schema.valid), 0) !== 1) ||
    !matchesValidation(database, entry.validation)
  ) {
    const validation = getSqliteDatabaseAdmission(database.db, agentDatabaseValidationKey);
    if (validation && matchesValidation(database, validation)) {
      if (
        entry &&
        (entry.agentId === undefined || entry.agentId === database.agentId) &&
        (!entry.validation || matchesValidation(database, entry.validation))
      ) {
        // Promotion keeps custody captured before this physical proof arrived.
        entry.agentId = database.agentId;
        if (entry.validation && entry.validation.receiptId === validation.receiptId) {
          // Schema publication refreshes the same receipt without replacing its borrowers' owner.
          entry.validation.schema = validation.schema;
        } else {
          entry.validation = validation;
        }
        entry.integrityVerified = true;
      } else {
        entry = { agentId: database.agentId, validation, integrityVerified: true };
        validatedPaths.set(pathname, entry);
      }
    }
  }
  if (
    !entry?.integrityVerified ||
    !entry.validation ||
    !matchesValidation(database, entry.validation)
  ) {
    return undefined;
  }
  bindValidationLifetime(database, entry.validation);
  return entry.validation;
}

/** The receiving opener must adopt this proof against its own physical file identity. */
export function getOpenClawAgentDatabaseValidationForTransfer(
  database: Pick<ValidationDatabase, "agentId" | "path">,
): OpenClawAgentDatabaseValidation | undefined {
  const pathname = validatedPaths.has(database.path)
    ? database.path
    : resolveDatabasePathKey(database.path);
  const entry = validatedPaths.get(pathname);
  if (
    !entry?.integrityVerified ||
    entry.validation?.agentId !== database.agentId ||
    Atomics.load(new Int32Array(entry.validation.valid), 0) !== 1
  ) {
    return undefined;
  }
  return entry.validation;
}

/** Readers borrow physical/canonical proof without copying the schema catalog or opening a host handle. */
export function captureOpenClawAgentDatabaseReadValidation(
  database: Pick<ValidationDatabase, "agentId" | "path">,
  mode: "retained" | "admission" = "retained",
) {
  const current = getOpenClawAgentDatabaseValidationForTransfer(database);
  if (!current) {
    return undefined;
  }
  let canonicalPath = database.path;
  if (validatedPaths.has(canonicalPath)) {
    observeValidationPath(canonicalPath, mode === "admission");
    if (Atomics.load(new Int32Array(current.valid), 0) !== 1) {
      return undefined;
    }
  } else {
    const capturedIdentity = readDatabasePathIdentitySync(database.path);
    if (
      capturedIdentity.key !== `file:${current.identity}` ||
      capturedIdentity.birthtime !== current.birthtime
    ) {
      return undefined;
    }
    canonicalPath = capturedIdentity.canonicalPath;
  }
  const { agentId, identity, birthtime, receiptId, valid, canonicalReady } = current;
  const validation: OpenClawAgentDatabaseReadValidation = {
    agentId,
    identity,
    birthtime,
    receiptId,
    valid,
    canonicalReady,
  };
  return {
    canonicalPath,
    validation,
    inputBytes:
      JSON.stringify(validation).length * 2 + valid.byteLength + canonicalReady.byteLength,
    assertCurrent() {
      if (getOpenClawAgentDatabaseValidationForTransfer(database) !== current) {
        throw new Error("Session reader validation is no longer current");
      }
    },
  };
}

/** Retire a replaced file's proof before capturing its successor's publication guard. */
export function retireReplacedAgentValidation(
  agentId: string,
  pathname: string,
  expectedIdentity?: { physicalIdentity: string },
): void {
  if (!expectedIdentity) {
    return;
  }
  const retainedValidation = getOpenClawAgentDatabaseValidationForTransfer({
    agentId,
    path: pathname,
  });
  if (retainedValidation && retainedValidation.identity !== expectedIdentity.physicalIdentity) {
    invalidateOpenClawAgentDatabaseValidation(pathname, retainedValidation.identity);
  }
}

/** Native admission supplies the checked file identity; no host SQLite handle is needed. */
export function captureOpenClawAgentDatabaseValidationTransfer(
  database: Pick<ValidationDatabase, "agentId" | "path">,
): (identity: string, received: unknown) => boolean {
  const receive = captureValidationTransfer(database, false);
  return (identity, received) => receive(identity, received) === "accepted";
}

function captureValidationTransfer(
  database: Pick<ValidationDatabase, "agentId" | "path">,
  schemaRequired: boolean,
): (identity: string, received: unknown) => "accepted" | "stale" | "invalid" {
  const pathname = resolveDatabasePathKey(database.path);
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
  return (identity, value) => {
    const received = agentDatabaseValidationKey.read(value);
    if (
      !received ||
      received.agentId !== database.agentId ||
      received.identity !== identity ||
      typeof received.birthtime !== "string" ||
      typeof received.receiptId !== "string" ||
      received.receiptId.length === 0
    ) {
      return "invalid";
    }
    const schema = received.schema;
    const valid = Atomics.load(new Int32Array(received.valid), 0);
    const schemaValid = schema && Atomics.load(new Int32Array(schema.valid), 0);
    // A raced capture cannot turn a malformed receipt into a retryable refusal.
    if (
      (valid !== 0 && valid !== 1) ||
      (schemaRequired && (!schema || (schemaValid !== 0 && schemaValid !== 1)))
    ) {
      return "invalid";
    }
    if (
      (schemaRequired && schemaValid !== 1) ||
      validatedPaths.get(pathname) !== captured ||
      (capturedValidation &&
        wasValid === 1 &&
        Atomics.load(new Int32Array(capturedValidation.valid), 0) !== 1) ||
      (captured.validation !== capturedValidation &&
        captured.validation &&
        (captured.validation.identity !== identity ||
          Atomics.load(new Int32Array(captured.validation.valid), 0) !== 1)) ||
      Atomics.load(new Int32Array(received.valid), 0) !== 1
    ) {
      if (schemaRequired && validatedPaths.get(pathname)?.revoked) {
        // A refused opener may already have shared its receipt with another worker.
        Atomics.store(new Int32Array(received.valid), 0, 0);
      }
      return "stale";
    }
    if (
      captured.integrityVerified &&
      captured.validation?.agentId === database.agentId &&
      captured.validation.identity === identity &&
      captured.validation.birthtime === received.birthtime &&
      Atomics.load(new Int32Array(captured.validation.valid), 0) === 1
    ) {
      const currentSchema = captured.validation.schema;
      if (
        currentSchema &&
        schema &&
        schemaValid === 1 &&
        Atomics.load(new Int32Array(currentSchema.valid), 0) === 1 &&
        matchesValidationSchema(currentSchema, schema)
      ) {
        // Retain the cell already shared with borrowers, including structured-clone aliases.
        return "accepted";
      }
      if (currentSchema) {
        Atomics.store(new Int32Array(currentSchema.valid), 0, 0);
      }
      captured.validation.schema = schema;
      return "accepted";
    }
    if (hasRevokedOpenClawAgentDatabaseValidation(pathname)) {
      Atomics.store(new Int32Array(received.canonicalReady), 0, 0);
    }
    const aliases =
      captured.validation?.identity === identity
        ? [...validatedPaths].flatMap(([candidate, entry]) =>
            entry.validation?.agentId === database.agentId && entry.validation.identity === identity
              ? [candidate]
              : [],
          )
        : [];
    // Revocation before capture already fenced this receipt. Repeating it would
    // invalidate an alias's later capture or an acknowledged successor receipt.
    if (wasValid !== 0) {
      invalidateOpenClawAgentDatabaseValidation(pathname);
    } else {
      // Worker cleanup can revoke one borrowed receipt while independent aliases remain live.
      for (const alias of aliases) {
        const superseded = validatedPaths.get(alias)?.validation;
        if (superseded && superseded.receiptId !== received.receiptId) {
          Atomics.store(new Int32Array(superseded.valid), 0, 0);
        }
      }
    }
    validatedPaths.set(pathname, { validation: received, integrityVerified: true });
    // A verified replacement is one physical receipt, including its already-admitted aliases.
    for (const alias of aliases) {
      validatedPaths.set(alias, { validation: received, integrityVerified: true });
    }
    return "accepted";
  };
}

/** An admitted runtime acquisition must receive a current schema, never fall back to host scans. */
export function captureOpenClawAgentDatabaseAdmissionPublication(
  database: Pick<ValidationDatabase, "agentId" | "path">,
): (identity: string, received: unknown) => void {
  const receive = captureValidationTransfer(database, true);
  return (identity, received) => {
    const result = receive(identity, received);
    if (result === "invalid") {
      throw new AgentDatabaseSchemaAdmissionInvalidError();
    }
    const schema = getOpenClawAgentDatabaseValidationForTransfer(database)?.schema;
    if (result === "stale" || !schema || Atomics.load(new Int32Array(schema.valid), 0) !== 1) {
      throw new AgentDatabaseSchemaAdmissionChangedError();
    }
  };
}

/** An alias may consume the exact acknowledged physical receipt without revoking it again. */
export function captureOpenClawAgentDatabaseAliasPublication(
  database: Pick<ValidationDatabase, "agentId" | "path">,
): (identity: string, received: unknown) => void {
  const publish = captureOpenClawAgentDatabaseAdmissionPublication(database);
  return (identity, received) => {
    const current = getOpenClawAgentDatabaseValidationForTransfer(database);
    if (
      isRecord(received) &&
      received.agentId === database.agentId &&
      received.identity === identity &&
      current?.identity === identity &&
      typeof received.receiptId === "string" &&
      received.receiptId.length > 0 &&
      current.receiptId === received.receiptId &&
      current.valid === received.valid &&
      current.schema &&
      isRecord(received.schema) &&
      current.schema.valid === received.schema.valid &&
      Atomics.load(new Int32Array(current.schema.valid), 0) === 1
    ) {
      return;
    }
    publish(identity, received);
  };
}

function canonicalValidationReceipt(
  database: CanonicalValidationDatabase,
): OpenClawAgentDatabaseValidation | undefined {
  const pathname = findOpenClawAgentDatabaseIdentity(database)?.canonicalPath;
  if (!database.db.isOpen || !pathname) {
    return undefined;
  }
  const validation = validatedPaths.get(pathname)?.validation;
  if (!validation || !matchesValidation(database, validation)) {
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
  const pathname = findOpenClawAgentDatabaseIdentity(database)?.canonicalPath;
  if (
    !pathname ||
    database.db.isTransaction ||
    validatedPaths.get(pathname)?.validation !== undefined ||
    hasRevokedOpenClawAgentDatabaseValidation(pathname) ||
    !hasPersistedOpenClawAgentCanonicalValidation(database)
  ) {
    return false;
  }
  const canonical = createOpenClawAgentDatabaseValidationReceipt(database, true);
  const entry: ValidationEntry = validatedPaths.get(pathname) ?? {
    integrityVerified: false,
  };
  // A canonical read enriches this owner; only revocation replaces its handoff identity.
  entry.validation = canonical;
  validatedPaths.set(pathname, entry);
  bindValidationLifetime({ ...database, path: pathname }, canonical);
  return true;
}

/** Offline import/repair owns exclusive custody; rollback may conservatively require validation. */
export function invalidateOpenClawAgentCanonicalValidation(
  database: CanonicalValidationDatabase,
): void {
  const validation = canonicalValidationReceipt(database);
  if (validation) {
    Atomics.store(new Int32Array(validation.canonicalReady), 0, 0);
    // A seal can restore a separate copy of this receipt after the last handle closes.
    const pathname = findOpenClawAgentDatabaseIdentity(database)?.canonicalPath;
    if (pathname && validatedPaths.get(pathname)?.integrityVerified) {
      publishSqliteDatabaseAdmission(database.db, agentDatabaseValidationKey, validation);
    }
  }
  clearPersistedOpenClawAgentCanonicalValidation(database);
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
  const pathname = readOpenClawAgentDatabaseIdentity(database).canonicalPath;
  if (hasRevokedOpenClawAgentDatabaseValidation(pathname)) {
    // Integrity handoff cannot replace the parent's requested canonical certification.
    Atomics.store(new Int32Array(validation.canonicalReady), 0, 0);
  }
  invalidateOpenClawAgentDatabaseValidation(pathname);
  validatedPaths.set(pathname, { validation, integrityVerified: true });
  bindValidationLifetime(database, validation);
  return true;
}

function isOpenClawAgentCanonicalStoreEmpty(database: { db: EngineConnection }): boolean {
  if (
    database.db.isTransaction ||
    readAgentDatabaseSchemaVersion(database.db) < CANONICAL_SESSION_VALIDATION_SCHEMA_VERSION
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
  const pathname = readOpenClawAgentDatabaseIdentity(database).canonicalPath;
  const revoked = hasRevokedOpenClawAgentDatabaseValidation(pathname);
  let validation = createOpenClawAgentDatabaseValidationReceipt(
    database,
    isOpenClawAgentCanonicalStoreEmpty(database) ||
      (!revoked &&
        !database.db.isTransaction &&
        loadOpenClawAgentCanonicalValidationReceipt(database)),
  );
  const entry = validatedPaths.get(pathname);
  if (
    !revoked &&
    entry &&
    (entry.agentId === undefined || entry.agentId === database.agentId) &&
    (!entry.validation || matchesValidation(database, entry.validation))
  ) {
    // Successful admission promotes this owner; only revocation retires pending handoffs.
    if (entry.validation) {
      if (validation.integrityVerifiedAt !== undefined) {
        entry.validation.integrityVerifiedAt = validation.integrityVerifiedAt;
      }
      Atomics.store(
        new Int32Array(entry.validation.canonicalReady),
        0,
        Atomics.load(new Int32Array(validation.canonicalReady), 0),
      );
      validation = entry.validation;
    }
    entry.validation = validation;
    entry.integrityVerified = true;
  } else {
    invalidateOpenClawAgentDatabaseValidation(pathname);
    validatedPaths.set(pathname, { validation, integrityVerified: true });
  }
  bindValidationLifetime(database, validation);
  publishOpenClawAgentDatabaseSchema(database);
  return validation;
}

/** The open/migration owner calls this only after complete canonical schema validation. */
export function publishOpenClawAgentDatabaseSchema(database: ValidationDatabase): void {
  publishAgentValidationSchema(database, getOpenClawAgentDatabaseValidation(database));
}

export function invalidateOpenClawAgentDatabaseValidation(
  pathname: string,
  identity = validatedPaths.get(resolveDatabasePathKey(pathname))?.validation?.identity,
): void {
  const resolved = resolveDatabasePathKey(pathname);
  const paths = new Set([resolved]);
  if (identity) {
    for (const [candidate, entry] of validatedPaths) {
      if (entry.validation?.identity === identity) {
        paths.add(candidate);
      }
    }
  }
  for (const candidate of paths) {
    releaseValidationObservation(candidate);
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
  const rootKey = rootPath === undefined ? undefined : resolveDatabasePathKey(rootPath);
  for (const pathname of validatedPaths.keys()) {
    if (rootKey === undefined || isPathInside(rootKey, pathname)) {
      invalidateOpenClawAgentDatabaseValidation(pathname);
      validatedPaths.delete(pathname);
    }
  }
}

/** Reader cleanup releases local metadata without revoking its parent's shared proof. */
export function releaseOpenClawAgentDatabaseReadValidation(
  candidates: readonly Pick<OpenClawAgentDatabaseReadCandidateResource, "path" | "scope">[],
  retainedPaths: readonly string[] = [],
): void {
  // Cleanup consumes captured physical paths, even when discovery found an unreadable directory.
  for (const pathname of validatedPaths.keys()) {
    if (
      !retainedPaths.some((retained) =>
        matchesAgentDatabaseReadCandidatePath({ path: retained }, pathname),
      ) &&
      candidates.some((candidate) => matchesAgentDatabaseReadCandidatePath(candidate, pathname))
    ) {
      releaseValidationObservation(pathname);
      validatedPaths.delete(pathname);
    }
  }
}
