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
import { findOpenClawAgentDatabaseIdentity } from "../../state/openclaw-agent-db-identity.js";
import {
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
const readerAdmissions = resolveGlobalSingleton(
  Symbol.for("openclaw.canonicalSessionReaderAdmissions"),
  () => new WeakMap<DatabaseSync, { proof?: ReaderAdmission }>(),
);
type CanonicalReadScope = { database: DatabaseSync; snapshotRequired?: Error };
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
    cell = {};
    readerAdmissions.set(database, cell);
    const unregister = registerNodeSqliteDisposeCallback(database, () => {
      readerAdmissions.delete(database);
      unregister();
    });
  }
  const owned = cell;
  const previous = owned.proof;
  if (database.isTransaction) {
    stageSqliteTransactionState(database, {
      stage: () => {
        owned.proof = proof;
      },
      rollback: () => {
        if (readerAdmissions.get(database) === owned && owned.proof === proof) {
          owned.proof = previous;
        }
      },
      commit: () => {},
    });
  } else {
    owned.proof = proof;
  }
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

function assertCanonicalSessionMainKeyWrite(sessionKey: string, mainKey: string): void {
  if (parseAgentSessionKey(sessionKey)?.rest === "main" && mainKey !== "main") {
    throw canonicalSessionKeyMigrationRequiredError(
      `refusing non-canonical session key write ${sessionKey}`,
    );
  }
}

export function assertCanonicalSessionEntryLineageWrite(
  database: { db: DatabaseSync },
  entry: SessionEntry,
): void {
  const sessionKeys = [
    entry.parentSessionKey,
    entry.spawnedBy,
    entry.forkSource?.sessionKey,
  ].filter((sessionKey): sessionKey is string => sessionKey !== undefined);
  if (sessionKeys.length === 0) {
    return;
  }
  const mainKey = readCanonicalSessionMainKey(database);
  for (const sessionKey of sessionKeys) {
    assertCanonicalSessionKeyWrite(sessionKey);
    assertCanonicalSessionMainKeyWrite(sessionKey, mainKey);
  }
}

export function assertCanonicalSessionKeyWriteMatchesDatabase(
  database: { agentId: string; db: DatabaseSync; path?: string },
  sessionKey: string,
): void {
  // Exact SQLite locators are shared stores; the outer resolved scope already enforces
  // logical agent ownership before this database-level shape check.
  assertCanonicalSessionKeyWrite(sessionKey);
  assertCanonicalSessionMainKeyWrite(sessionKey, readCanonicalSessionMainKey(database));
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
  if (readSqliteUserVersion(database.db) < CANONICAL_SESSION_VALIDATION_SCHEMA_VERSION) {
    return false;
  }
  assertCanonicalSessionValidationSchema(database.db);
  return true;
}

export function scanCanonicalSqliteSessionEntries(
  database: { agentId: string; db: DatabaseSync; path?: string },
  visit?: (summary: { entry: SessionEntry; sessionKey: string }) => void,
  mainKey?: string,
  metadata?: CanonicalSessionMetadata,
): number {
  // Doctor visitors and full inventories retain complete validation and source JSON semantics.
  const db = getNodeSqliteKysely<CanonicalSessionDatabase>(database.db);
  const storedMainKey = executeSqliteQueryTakeFirstSync(
    database.db,
    db.selectFrom("session_key_contract").select("main_key").where("id", "=", 1),
  )?.main_key;
  const canonicalMainKey = normalizeMainKey(mainKey ?? storedMainKey);
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
    const entry = validateCanonicalSessionRow(row, canonicalMainKey);
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
  mainKey?: string,
  collectMetadata = false,
): ValidatedSessionMetadata | undefined {
  return validateCanonicalSqliteSessionKeys(database, mainKey, collectMetadata).metadata;
}

/** Validate the root's database and key together within its synchronous writer transaction. */
export function assertCanonicalSqliteSessionRootWrite(
  database: { agentId: string; db: DatabaseSync },
  sessionKey: string,
): void {
  const { validatedMainKey } = validateCanonicalSqliteSessionKeys(database);
  assertCanonicalSessionKeyWrite(sessionKey);
  // Warm validation just read this policy. Cold or changed-policy scans retain
  // their original post-scan read and error order.
  assertCanonicalSessionMainKeyWrite(
    sessionKey,
    validatedMainKey ?? readCanonicalSessionMainKey(database),
  );
}

function validateCanonicalSqliteSessionKeys(
  database: { agentId: string; db: DatabaseSync; path?: string },
  mainKey?: string,
  collectMetadata = false,
): { validatedMainKey?: string; metadata?: ValidatedSessionMetadata } {
  const incremental = hasCanonicalSessionValidationProjection(database);
  const identity = findOpenClawAgentDatabaseIdentity(database);
  const pathname = database.path ?? identity?.filename;
  const physicalValidation = pathname
    ? getOpenClawAgentDatabaseValidation({ ...database, path: pathname })
    : undefined;
  const storedMainKey = readCanonicalSessionMainKey(database);
  const canonicalReady = hasOpenClawAgentCanonicalValidation(database);
  const admitted = readerAdmissions.get(database.db)?.proof;
  // Preserve admitted-reader parsing for raw metadata edits; new handles and
  // policy/owner changes must cross canonical admission again. Rows are never cached here.
  if (
    admitted?.mainKey === storedMainKey &&
    admitted.physicalValidation === physicalValidation &&
    admitted.canonicalReady === canonicalReady
  ) {
    return { validatedMainKey: storedMainKey };
  }
  const readScope = canonicalReadScope.current;
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
      scanCanonicalSqliteSessionEntries(database, undefined, mainKey, metadata);
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
      scanCanonicalSqliteSessionEntries(database, undefined, mainKey, metadata);
      remember();
      return { metadata };
    }
    const query = canonicalSessionValidationQuery(database)
      .where("session_nodes.session_key", "in", pending)
      .select((eb) =>
        eb
          .selectFrom("session_key_contract")
          .select("main_key")
          .where("id", "=", 1)
          .as("validation_main_key"),
      );
    for (const row of iterateSqliteQuerySync(database.db, query)) {
      // Policy and pending rows belong to the same statement's committed snapshot.
      validateCanonicalSessionRow(row, normalizeMainKey(mainKey ?? row.validation_main_key));
    }
    remember();
    return {};
  }
  const metadata: ValidatedSessionMetadata | undefined = collectMetadata
    ? { dataVersion: readSqliteDataVersion(database.db), entries: new Map(), keys: [] }
    : undefined;
  scanCanonicalSqliteSessionEntries(database, undefined, mainKey, metadata);
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
    admission.proof = undefined;
  }
}
