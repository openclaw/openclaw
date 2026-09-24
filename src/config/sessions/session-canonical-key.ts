import type { DatabaseSync } from "node:sqlite";
import { registerNodeSqliteDisposeCallback } from "../../infra/kysely-sync-cache-state.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
  iterateSqliteQuerySync,
  prepareSqliteQueryTakeFirstSync,
} from "../../infra/kysely-sync.js";
import { readSqliteDataVersion } from "../../infra/node-sqlite.js";
import {
  stageSqliteTransactionState,
  withSqlitePostCommitPublications,
} from "../../infra/sqlite-post-commit.js";
import { getAdmittedSqliteSchemaFacts } from "../../infra/sqlite-schema-facts.js";
import { runSqliteDeferredTransactionSync } from "../../infra/sqlite-transaction.js";
import { readSqliteUserVersion } from "../../infra/sqlite-user-version.js";
import {
  normalizeAgentId,
  normalizeMainKey,
  parseAgentSessionKey,
} from "../../routing/session-key.js";
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";
import { assertCanonicalSessionValidationSchema } from "../../state/openclaw-agent-canonical-validation-schema.js";
import { CANONICAL_SESSION_VALIDATION_SCHEMA_VERSION } from "../../state/openclaw-agent-db-contract.js";
import {
  findOpenClawAgentDatabaseIdentity,
  isOpenClawAgentDatabasePathCurrent,
} from "../../state/openclaw-agent-db-identity.js";
import {
  adoptOpenClawAgentDatabaseValidation,
  getOpenClawAgentDatabaseValidation,
  type OpenClawAgentDatabaseValidation,
  hasOpenClawAgentCanonicalValidation,
  markOpenClawAgentCanonicalValidation,
} from "../../state/openclaw-agent-db-validation-cache.js";
import type { DB as OpenClawAgentKyselyDatabase } from "../../state/openclaw-agent-db.generated.js";
import {
  hasSqliteSessionOwnerColumns,
  projectSqliteSessionOwner,
} from "./session-accessor.sqlite-owner-projection.js";
import { sessionEntryMetadataJson } from "./session-accessor.sqlite-status.js";
import {
  canonicalSessionKeyMigrationRequiredError,
  validateCanonicalSessionRow,
} from "./session-canonical-row.js";
import { deferCanonicalSessionValidation } from "./session-canonical-validation-deferral.js";
import { normalizeStoreSessionKey } from "./store-entry.js";
import type { SessionEntry } from "./types.js";

export { canonicalSessionKeyMigrationRequiredError } from "./session-canonical-row.js";

type CanonicalSessionDatabase = Pick<
  OpenClawAgentKyselyDatabase,
  | "schema_meta"
  | "session_key_contract"
  | "session_nodes"
  | "session_windows"
  | "session_canonical_validation_pending"
>;
const mainKeyReaders = new WeakMap<DatabaseSync, () => { main_key: string } | undefined>();

type ReaderAdmission = {
  mainKey: string;
  canonicalReady: boolean;
  physicalValidation?: OpenClawAgentDatabaseValidation;
};
type ReaderAdmissionCell = {
  proof?: ReaderAdmission;
  committed: boolean;
  continuations: Set<SharedArrayBuffer>;
};
const readerAdmissions = resolveGlobalSingleton(
  Symbol.for("openclaw.canonicalSessionReaderAdmissions"),
  () => new WeakMap<DatabaseSync, ReaderAdmissionCell>(),
);
export type CanonicalSessionReaderContinuation = {
  agentId: string;
  identity: string;
  birthtime: string | undefined;
  mainKey: string;
  canonicalReady: boolean;
  validation: OpenClawAgentDatabaseValidation;
  live: SharedArrayBuffer;
};
type CanonicalReadScope = {
  database: DatabaseSync;
  snapshotRequired?: Error;
  continuation?: CanonicalSessionReaderContinuation;
  usedContinuation?: boolean;
};
const canonicalReadScope = resolveGlobalSingleton<{ current?: CanonicalReadScope }>(
  Symbol.for("openclaw.canonicalSessionReadScope"),
  () => ({}),
);

/** Only first admission needs a shared snapshot; warm materialized reads keep their existing cost. */
export function readWithCanonicalSessionAdmission<T>(
  database: { db: DatabaseSync },
  read: () => T,
): T {
  if (database.db.isTransaction) {
    return read();
  }
  const previous = canonicalReadScope.current;
  const scope: CanonicalReadScope = { database: database.db };
  canonicalReadScope.current = scope;
  try {
    return read();
  } catch (error) {
    if (scope.snapshotRequired === undefined || error !== scope.snapshotRequired) {
      throw error;
    }
  } finally {
    canonicalReadScope.current = previous;
  }
  // The actual guard requested admission before validation or publication. Retry
  // the materialized read under one snapshot, including policy/receipt changes.
  return withSqlitePostCommitPublications(database.db, () =>
    runSqliteDeferredTransactionSync(database.db, read),
  );
}

function rememberReaderAdmission(database: DatabaseSync, proof: ReaderAdmission): void {
  let cell = readerAdmissions.get(database);
  if (!cell) {
    cell = { committed: false, continuations: new Set() };
    readerAdmissions.set(database, cell);
    const owned = cell;
    const unregister = registerNodeSqliteDisposeCallback(database, () => {
      revokeReaderContinuations(owned);
      readerAdmissions.delete(database);
      unregister();
    });
  }
  const owned = cell;
  const previous = owned.proof;
  const previouslyCommitted = owned.committed;
  if (database.isTransaction) {
    const staged = stageSqliteTransactionState(database, {
      stage: () => {
        revokeReaderContinuations(owned);
        owned.proof = proof;
        owned.committed = false;
      },
      rollback: () => {
        if (readerAdmissions.get(database) === owned && owned.proof === proof) {
          revokeReaderContinuations(owned);
          owned.proof = previous;
          owned.committed = previouslyCommitted;
        }
      },
      commit: () => {
        if (readerAdmissions.get(database) === owned && owned.proof === proof) {
          owned.committed = true;
        }
      },
    });
    if (!staged) {
      // Without a transaction owner, neither commit nor rollback can retain this admission.
      revokeReaderContinuations(owned);
      owned.proof = undefined;
      owned.committed = false;
    }
  } else {
    revokeReaderContinuations(owned);
    owned.proof = proof;
    owned.committed = true;
  }
}

function revokeReaderContinuations(cell: ReaderAdmissionCell): void {
  for (const live of cell.continuations) {
    Atomics.store(new Int32Array(live), 0, 0);
  }
  cell.continuations.clear();
}

function isReaderContinuationLive(receipt: CanonicalSessionReaderContinuation): boolean {
  return (
    Atomics.load(new Int32Array(receipt.live), 0) === 1 &&
    Atomics.load(new Int32Array(receipt.validation.valid), 0) === 1 &&
    (Atomics.load(new Int32Array(receipt.validation.canonicalReady), 0) === 1) ===
      receipt.canonicalReady
  );
}

function matchesReaderContinuationDatabase(
  database: { agentId: string; db: DatabaseSync; path?: string },
  receipt: CanonicalSessionReaderContinuation,
): boolean {
  const identity = findOpenClawAgentDatabaseIdentity(database);
  return (
    database.db.isOpen &&
    database.agentId === receipt.agentId &&
    identity?.identity === receipt.identity &&
    identity.birthtime === receipt.birthtime &&
    isOpenClawAgentDatabasePathCurrent({
      db: database.db,
      path: database.path ?? identity.filename,
    }) &&
    receipt.validation.agentId === receipt.agentId &&
    receipt.validation.identity === receipt.identity &&
    isReaderContinuationLive(receipt)
  );
}

/** Borrow only existing committed admission; capture never opens or queries SQLite. */
export function captureCanonicalSessionReaderContinuation(database: {
  agentId: string;
  db: DatabaseSync;
  path: string;
}):
  | { receipt: CanonicalSessionReaderContinuation; assertCurrent: () => void; release: () => void }
  | undefined {
  const cell = readerAdmissions.get(database.db);
  const proof = cell?.proof;
  if (!database.db.isOpen || database.db.isTransaction || !cell?.committed || !proof) {
    return undefined;
  }
  const validation = getOpenClawAgentDatabaseValidation(database);
  const identity = findOpenClawAgentDatabaseIdentity(database);
  if (
    !validation ||
    validation !== proof.physicalValidation ||
    typeof identity?.identity !== "string"
  ) {
    return undefined;
  }
  const receipt: CanonicalSessionReaderContinuation = {
    agentId: database.agentId,
    identity: identity.identity,
    birthtime: identity.birthtime,
    mainKey: proof.mainKey,
    canonicalReady: proof.canonicalReady,
    validation,
    live: new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT),
  };
  Atomics.store(new Int32Array(receipt.live), 0, 1);
  const isCurrent = () =>
    database.db.isOpen &&
    !database.db.isTransaction &&
    readerAdmissions.get(database.db) === cell &&
    cell.proof === proof &&
    cell.committed &&
    getOpenClawAgentDatabaseValidation(database) === validation &&
    matchesReaderContinuationDatabase(database, receipt);
  if (!isCurrent()) {
    return undefined;
  }
  cell.continuations.add(receipt.live);
  return {
    receipt,
    assertCurrent: () => {
      if (!isCurrent()) {
        throw new Error("Canonical session reader continuation is no longer current");
      }
    },
    release: () => {
      Atomics.store(new Int32Array(receipt.live), 0, 0);
      cell.continuations.delete(receipt.live);
    },
  };
}

/** Continue one retained reader without admitting unrelated reads on a pooled handle. */
export function readWithCanonicalSessionReaderContinuation<T>(
  database: { agentId: string; db: DatabaseSync; path?: string },
  receipt: CanonicalSessionReaderContinuation | undefined,
  read: () => T,
): T {
  const identity = findOpenClawAgentDatabaseIdentity(database);
  if (
    !receipt ||
    database.db.isTransaction ||
    !identity ||
    !matchesReaderContinuationDatabase(database, receipt) ||
    !adoptOpenClawAgentDatabaseValidation(
      { ...database, path: database.path ?? identity.filename },
      receipt.validation,
    )
  ) {
    return readWithCanonicalSessionAdmission(database, read);
  }
  const scope: CanonicalReadScope = { database: database.db, continuation: receipt };
  const assertCurrent = () => {
    if (scope.usedContinuation && !matchesReaderContinuationDatabase(database, receipt)) {
      throw new Error("Canonical session reader continuation is no longer current");
    }
  };
  const value = withSqlitePostCommitPublications(database.db, () =>
    runSqliteDeferredTransactionSync(database.db, () => {
      const previous = canonicalReadScope.current;
      canonicalReadScope.current = scope;
      try {
        const result = read();
        assertCurrent();
        return result;
      } finally {
        canonicalReadScope.current = previous;
      }
    }),
  );
  assertCurrent();
  return value;
}

type CanonicalSessionMetadata = {
  entries: Map<string, SessionEntry>;
  keys: string[];
};

export type ValidatedSessionMetadata = CanonicalSessionMetadata & { dataVersion: number };

function isCanonicalSessionKey(sessionKey: string): boolean {
  const trimmed = sessionKey.trim();
  if (!trimmed || sessionKey !== trimmed) {
    return false;
  }
  if (normalizeStoreSessionKey(sessionKey) !== sessionKey) {
    return false;
  }
  const parsed = parseAgentSessionKey(trimmed);
  return (
    trimmed === "global" ||
    trimmed === "unknown" ||
    (parsed !== null && trimmed.startsWith(`agent:${parsed.agentId}:`))
  );
}

export function assertCanonicalSessionKeyWrite(sessionKey: string, expectedAgentId?: string): void {
  const parsed = parseAgentSessionKey(sessionKey);
  if (
    !isCanonicalSessionKey(sessionKey) ||
    (expectedAgentId && parsed && parsed.agentId !== normalizeAgentId(expectedAgentId))
  ) {
    throw canonicalSessionKeyMigrationRequiredError(
      `refusing non-canonical session key write ${sessionKey}`,
    );
  }
}

export function readCanonicalSessionMainKey(database: { db: DatabaseSync }): string {
  let read = mainKeyReaders.get(database.db);
  if (!read) {
    const query = prepareSqliteQueryTakeFirstSync<void, { main_key: string }>(database.db, () =>
      getNodeSqliteKysely<CanonicalSessionDatabase>(database.db)
        .selectFrom("session_key_contract")
        .select("main_key")
        .where("id", "=", 1),
    );
    read = () => query();
    mainKeyReaders.set(database.db, read);
  }
  return normalizeMainKey(read()?.main_key);
}

export function assertCanonicalSessionEntryLineageWrite(entry: SessionEntry): void {
  const sessionKeys = [
    entry.parentSessionKey,
    entry.spawnedBy,
    entry.forkSource?.sessionKey,
  ].filter((sessionKey): sessionKey is string => sessionKey !== undefined);
  if (sessionKeys.length === 0) {
    return;
  }
  for (const sessionKey of sessionKeys) {
    assertCanonicalSessionKeyWrite(sessionKey);
  }
}

/** Query shape shared by complete inventories and bounded canonical validation. */
export function canonicalSessionValidationQuery(
  database: { db: DatabaseSync },
  options: { fullEntries?: boolean; metadata?: boolean } = {},
) {
  return (
    getNodeSqliteKysely<CanonicalSessionDatabase>(database.db)
      .selectFrom("session_nodes")
      .leftJoin("session_windows as retained_window", (join) =>
        join
          .onRef("retained_window.session_id", "=", "session_nodes.current_session_id")
          .onRef("retained_window.session_key", "=", "session_nodes.session_key"),
      )
      .select([
        "session_nodes.session_key",
        "session_nodes.current_session_id",
        "session_nodes.entry_valid",
        "session_nodes.fork_source_session_key",
        "session_nodes.parent_session_key",
        "session_nodes.spawned_by",
        "retained_window.session_id as retained_window_id",
      ])
      // Key validation needs metadata; Doctor visitors still own complete saved entries.
      .select(options.fullEntries ? "session_nodes.entry_json" : sessionEntryMetadataJson)
      .$if(Boolean(options.metadata), (query) => query.select("session_nodes.updated_at"))
      .$if(Boolean(options.metadata) && hasSqliteSessionOwnerColumns(database.db), (query) =>
        query.select([
          "session_nodes.owner_actor_type",
          "session_nodes.owner_actor_id",
          "session_nodes.owner_assigned_by_type",
          "session_nodes.owner_assigned_by_id",
          "session_nodes.owner_assigned_at",
        ]),
      )
      .orderBy("session_nodes.session_key")
  );
}

/** Older supported maintenance readers keep their existing full-validation path. */
export function hasCanonicalSessionValidationProjection(database: { db: DatabaseSync }): boolean {
  const version =
    getAdmittedSqliteSchemaFacts(database.db)?.userVersion ?? readSqliteUserVersion(database.db);
  if (version < CANONICAL_SESSION_VALIDATION_SCHEMA_VERSION) {
    return false;
  }
  assertCanonicalSessionValidationSchema(database.db);
  return true;
}

export function scanCanonicalSqliteSessionEntries(
  database: { agentId: string; db: DatabaseSync; path?: string },
  visit?: (summary: { entry: SessionEntry; sessionKey: string }) => void,
  metadata?: CanonicalSessionMetadata,
): number {
  // Doctor visitors and full inventories retain complete validation and source JSON semantics.
  let count = 0;
  for (const row of iterateSqliteQuerySync(
    database.db,
    canonicalSessionValidationQuery(database, {
      fullEntries: Boolean(visit),
      metadata: Boolean(metadata),
    }),
  )) {
    // Retained windows have no entry, but their keys remain part of a listing snapshot.
    metadata?.keys.push(row.session_key);
    const entry = validateCanonicalSessionRow(row);
    if (!entry) {
      continue;
    }
    if (metadata && entry.updatedAt === row.updated_at) {
      // List decoding also checks the row timestamp and strips SQL-fallback prompt payloads;
      // neither rule belongs to canonical validation or Doctor's complete-entry visitor.
      const { skillsSnapshot: _skills, systemPromptReport: _report, ...listEntry } = entry;
      metadata.entries.set(row.session_key, projectSqliteSessionOwner(listEntry, row));
    }
    visit?.({ entry, sessionKey: row.session_key });
    count += 1;
  }
  return count;
}

export function assertCanonicalSqliteSessionKeysCurrent(
  database: { agentId: string; db: DatabaseSync; path?: string },
  collectMetadata = false,
): ValidatedSessionMetadata | undefined {
  return validateCanonicalSqliteSessionKeys(database, collectMetadata).metadata;
}

/** Validate the root's database and key together within its synchronous writer transaction. */
export function assertCanonicalSqliteSessionRootWrite(
  database: { agentId: string; db: DatabaseSync },
  sessionKey: string,
): void {
  validateCanonicalSqliteSessionKeys(database);
  assertCanonicalSessionKeyWrite(sessionKey);
}

function validateCanonicalSqliteSessionKeys(
  database: { agentId: string; db: DatabaseSync; path?: string },
  collectMetadata = false,
): { metadata?: ValidatedSessionMetadata } {
  const incremental = hasCanonicalSessionValidationProjection(database);
  const identity = findOpenClawAgentDatabaseIdentity(database);
  const pathname = database.path ?? identity?.filename;
  const physicalValidation = pathname
    ? getOpenClawAgentDatabaseValidation({ ...database, path: pathname })
    : undefined;
  const storedMainKey = readCanonicalSessionMainKey(database);
  const canonicalReady = hasOpenClawAgentCanonicalValidation(database);
  const readScope = canonicalReadScope.current;
  const continuation = readScope?.database === database.db ? readScope.continuation : undefined;
  if (
    readScope &&
    continuation &&
    physicalValidation &&
    continuation.mainKey === storedMainKey &&
    continuation.canonicalReady === canonicalReady &&
    matchesReaderContinuationDatabase(database, continuation)
  ) {
    readScope.usedContinuation = true;
    return {};
  }
  const admitted = readerAdmissions.get(database.db)?.proof;
  // Preserve admitted-reader parsing for raw metadata edits; new handles and
  // policy/owner changes must cross canonical admission again. Rows are never cached here.
  if (
    admitted?.mainKey === storedMainKey &&
    admitted.physicalValidation === physicalValidation &&
    admitted.canonicalReady === canonicalReady
  ) {
    return {};
  }
  if (readScope?.database === database.db && !database.db.isTransaction) {
    readScope.snapshotRequired ??= new Error(
      "Canonical session read requires an admission snapshot",
    );
    throw readScope.snapshotRequired;
  }
  const remember = () =>
    rememberReaderAdmission(database.db, {
      mainKey: storedMainKey,
      physicalValidation,
      canonicalReady: hasOpenClawAgentCanonicalValidation(database),
    });
  if (incremental) {
    const inMemory = typeof identity?.identity === "symbol";
    if (!inMemory && !canonicalReady) {
      // A copied clean projection is not first-admission proof for an unknown file.
      deferCanonicalSessionValidation(database);
      const metadata: ValidatedSessionMetadata | undefined = collectMetadata
        ? { dataVersion: readSqliteDataVersion(database.db), entries: new Map(), keys: [] }
        : undefined;
      scanCanonicalSqliteSessionEntries(database, undefined, metadata);
      markOpenClawAgentCanonicalValidation(database);
      remember();
      return { metadata };
    }
    const db = getNodeSqliteKysely<CanonicalSessionDatabase>(database.db);
    const pending = db.selectFrom("session_canonical_validation_pending").select("session_key");
    if (!executeSqliteQueryTakeFirstSync(database.db, pending.limit(1))) {
      remember();
      return {};
    }
    deferCanonicalSessionValidation(database);
    if (collectMetadata) {
      // A list already needs the whole inventory; hand its parsed rows through once.
      const metadata: ValidatedSessionMetadata = {
        dataVersion: readSqliteDataVersion(database.db),
        entries: new Map(),
        keys: [],
      };
      scanCanonicalSqliteSessionEntries(database, undefined, metadata);
      remember();
      return { metadata };
    }
    const query = canonicalSessionValidationQuery(database).where(
      "session_nodes.session_key",
      "in",
      pending,
    );
    for (const row of iterateSqliteQuerySync(database.db, query)) {
      validateCanonicalSessionRow(row);
    }
    remember();
    return {};
  }
  const metadata: ValidatedSessionMetadata | undefined = collectMetadata
    ? { dataVersion: readSqliteDataVersion(database.db), entries: new Map(), keys: [] }
    : undefined;
  scanCanonicalSqliteSessionEntries(database, undefined, metadata);
  remember();
  return { metadata };
}

export function setCanonicalSqliteSessionMainKey(
  database: { db: DatabaseSync },
  mainKey: string | undefined,
): void {
  const canonicalMainKey = normalizeMainKey(mainKey);
  const db = getNodeSqliteKysely<CanonicalSessionDatabase>(database.db);
  const currentMainKey = executeSqliteQueryTakeFirstSync(
    database.db,
    db.selectFrom("session_key_contract").select("main_key").where("id", "=", 1),
  )?.main_key;
  if (currentMainKey === canonicalMainKey) {
    return;
  }
  executeSqliteQuerySync(
    database.db,
    db
      .insertInto("session_key_contract")
      .values({ id: 1, main_key: canonicalMainKey, updated_at: Date.now() })
      .onConflict((conflict) =>
        conflict.column("id").doUpdateSet({
          main_key: canonicalMainKey,
          updated_at: Date.now(),
        }),
      ),
  );
  const admission = readerAdmissions.get(database.db);
  if (admission) {
    revokeReaderContinuations(admission);
    admission.proof = undefined;
    admission.committed = false;
  }
}
