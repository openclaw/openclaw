import type { DatabaseSync } from "node:sqlite";
import { toUSVString } from "node:util";
import { sql } from "kysely";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
  sqliteStringSet,
} from "../../infra/kysely-sync.js";
import { runSqliteDeferredTransactionSync } from "../../infra/sqlite-transaction.js";
import type { DB } from "../../state/openclaw-agent-db.generated.js";
import {
  canonicalSessionValidationQuery,
  hasCanonicalSessionValidationProjection,
  readCanonicalSessionMainKey,
} from "./session-canonical-key.js";
import {
  validateCanonicalSessionRow,
  type CanonicalSessionValidationRow,
} from "./session-canonical-row.js";

type ValidationDatabase = { agentId: string; db: DatabaseSync };
type PendingDatabase = Pick<DB, "session_nodes" | "session_canonical_validation_pending">;

export type CanonicalSessionValidationBatch = {
  mainKey: string;
  rows: readonly CanonicalSessionValidationRow[];
  absentKeys: readonly string[];
  hasMore: boolean;
  oversizedRows: number;
};

const validatedBatch = Symbol("validatedCanonicalSessionBatch");
export type ValidatedCanonicalSessionValidationBatch = Readonly<CanonicalSessionValidationBatch> & {
  readonly [validatedBatch]: true;
};

export function hasPendingCanonicalSessionValidation(database: ValidationDatabase): boolean {
  return (
    hasCanonicalSessionValidationProjection(database) &&
    Boolean(
      executeSqliteQueryTakeFirstSync(
        database.db,
        getNodeSqliteKysely<PendingDatabase>(database.db)
          .selectFrom("session_canonical_validation_pending")
          .select("session_key")
          .limit(1),
      ),
    )
  );
}

/** First physical admission must validate all rows, even when an imported projection is clean. */
export function seedCanonicalSessionValidation(database: ValidationDatabase): number {
  if (!database.db.isTransaction) {
    throw new Error("Canonical validation seeding requires write admission");
  }
  if (!hasCanonicalSessionValidationProjection(database)) {
    return 0;
  }
  const db = getNodeSqliteKysely<PendingDatabase>(database.db);
  const result = executeSqliteQuerySync(
    database.db,
    db
      .insertInto("session_canonical_validation_pending")
      .columns(["session_key"])
      // SQLite needs WHERE to disambiguate ON CONFLICT from a SELECT join clause.
      .expression(db.selectFrom("session_nodes").select("session_key").where(sql.lit(true)))
      .onConflict((conflict) => conflict.column("session_key").doNothing()),
  );
  return Number(result.numAffectedRows ?? 0n);
}

/** Capture bounded source bytes and policy in one committed snapshot before write admission. */
export function readPendingCanonicalSessionValidationBatch(
  database: ValidationDatabase,
  options: { maxRows: number; maxBytes: number },
): CanonicalSessionValidationBatch {
  if (
    !Number.isSafeInteger(options.maxRows) ||
    options.maxRows < 1 ||
    !Number.isSafeInteger(options.maxBytes) ||
    options.maxBytes < 1
  ) {
    throw new Error("Canonical validation batch limits must be positive safe integers");
  }
  if (!hasCanonicalSessionValidationProjection(database)) {
    return { mainKey: "main", rows: [], absentKeys: [], hasMore: false, oversizedRows: 0 };
  }
  return runSqliteDeferredTransactionSync(database.db, () => {
    const mainKey = readCanonicalSessionMainKey(database);
    const db = getNodeSqliteKysely<PendingDatabase>(database.db);
    const candidates = executeSqliteQuerySync(
      database.db,
      db
        .selectFrom("session_canonical_validation_pending as pending")
        .leftJoin("session_nodes as node", "node.session_key", "pending.session_key")
        .select("pending.session_key")
        // kysely-allow-raw: bound native TEXT bytes before materializing saved prompt payloads.
        .select(
          sql<number>`length(CAST(pending.session_key AS BLOB)) + coalesce(length(CAST(node.entry_json AS BLOB)), 0) + coalesce(length(CAST(node.current_session_id AS BLOB)), 0) * 2 + coalesce(length(CAST(node.parent_session_key AS BLOB)), 0) + coalesce(length(CAST(node.spawned_by AS BLOB)), 0) + coalesce(length(CAST(node.fork_source_session_key AS BLOB)), 0)`.as(
            "bytes",
          ),
        )
        .orderBy("pending.session_key")
        .limit(options.maxRows + 1),
    ).rows;
    const keys: string[] = [];
    let bytes = 0;
    let oversizedRows = 0;
    for (const candidate of candidates) {
      if (
        keys.length >= options.maxRows ||
        (keys.length > 0 && bytes + candidate.bytes > options.maxBytes)
      ) {
        break;
      }
      keys.push(candidate.session_key);
      bytes += candidate.bytes;
      if (candidate.bytes > options.maxBytes) {
        oversizedRows += 1;
      }
    }
    const rows = keys.length
      ? executeSqliteQuerySync(
          database.db,
          canonicalSessionValidationQuery(database, { fullEntries: true }).where(
            "session_nodes.session_key",
            "in",
            sqliteStringSet(keys),
          ),
        ).rows
      : [];
    const found = new Set(rows.map((row) => row.session_key));
    return {
      mainKey,
      rows,
      absentKeys: keys.filter((key) => !found.has(key)),
      hasMore: keys.length < candidates.length,
      oversizedRows,
    };
  });
}

/** Keep the exact validated flat fields private and immutable across awaited write admission. */
export function validateCanonicalSessionValidationBatch(
  batch: CanonicalSessionValidationBatch,
): ValidatedCanonicalSessionValidationBatch {
  const rows = batch.rows.map((row) => {
    const snapshot = { ...row };
    validateCanonicalSessionRow(snapshot, batch.mainKey);
    return Object.freeze(snapshot);
  });
  const validated: ValidatedCanonicalSessionValidationBatch = {
    ...batch,
    rows: Object.freeze(rows),
    absentKeys: Object.freeze([...batch.absentKeys]),
    [validatedBatch]: true,
  };
  return Object.freeze(validated);
}

function sameCanonicalRow(
  left: CanonicalSessionValidationRow,
  right: CanonicalSessionValidationRow,
): boolean {
  return (
    left.session_key === right.session_key &&
    left.current_session_id === right.current_session_id &&
    left.entry_valid === right.entry_valid &&
    left.entry_json === right.entry_json &&
    left.parent_session_key === right.parent_session_key &&
    left.spawned_by === right.spawned_by &&
    left.fork_source_session_key === right.fork_source_session_key &&
    left.retained_window_id === right.retained_window_id
  );
}

/** Settle only exact validated inputs; changed rows stay pending for the next owner admission. */
export function compareAndCertifyCanonicalSessionValidationBatch(
  database: ValidationDatabase,
  batch: ValidatedCanonicalSessionValidationBatch,
): number {
  if (!database.db.isTransaction) {
    throw new Error("Canonical validation certification requires write admission");
  }
  if (
    !hasCanonicalSessionValidationProjection(database) ||
    readCanonicalSessionMainKey(database) !== batch.mainKey
  ) {
    return 0;
  }
  const keys = [...batch.rows.map((row) => row.session_key), ...batch.absentKeys];
  if (keys.length === 0) {
    return 0;
  }
  const current = new Map(
    executeSqliteQuerySync(
      database.db,
      canonicalSessionValidationQuery(database, { fullEntries: true }).where(
        "session_nodes.session_key",
        "in",
        sqliteStringSet(keys),
      ),
    ).rows.map((row) => [row.session_key, row]),
  );
  const certifiedKeys = batch.rows.flatMap((row) => {
    const candidate = current.get(row.session_key);
    return candidate && sameCanonicalRow(row, candidate) ? [row.session_key] : [];
  });
  certifiedKeys.push(...batch.absentKeys.filter((key) => !current.has(key)));
  if (certifiedKeys.length === 0) {
    return 0;
  }
  const result = executeSqliteQuerySync(
    database.db,
    getNodeSqliteKysely<PendingDatabase>(database.db)
      .deleteFrom("session_canonical_validation_pending")
      .where("session_key", "in", sqliteStringSet(certifiedKeys)),
  );
  return Number(result.numAffectedRows ?? 0n);
}

/** Validate serialized writer bindings without copying their saved JSON back out of SQLite. */
export function certifyCanonicalSessionValidationEntry(
  database: ValidationDatabase,
  row: Omit<CanonicalSessionValidationRow, "entry_valid" | "retained_window_id">,
): void {
  if (!database.db.isTransaction || !hasCanonicalSessionValidationProjection(database)) {
    return;
  }
  // Native TEXT bindings replace unpaired surrogates; validate those stored
  // strings against the escaped JSON identity rather than the producer's UTF-16.
  const regularRow: CanonicalSessionValidationRow = {
    session_key: toUSVString(row.session_key),
    current_session_id: toUSVString(row.current_session_id),
    entry_json: toUSVString(row.entry_json),
    parent_session_key:
      row.parent_session_key === null ? null : toUSVString(row.parent_session_key),
    spawned_by: row.spawned_by === null ? null : toUSVString(row.spawned_by),
    fork_source_session_key:
      row.fork_source_session_key === null ? null : toUSVString(row.fork_source_session_key),
    entry_valid: 1,
    retained_window_id: null,
  };
  // Only regular entries use this path; the placeholder shortcut cannot certify them.
  validateCanonicalSessionRow(regularRow, readCanonicalSessionMainKey(database));
  const db = getNodeSqliteKysely<PendingDatabase>(database.db);
  executeSqliteQuerySync(
    database.db,
    db
      .deleteFrom("session_canonical_validation_pending")
      .where("session_key", "=", regularRow.session_key)
      .where((eb) =>
        eb.exists(
          eb
            .selectFrom("session_nodes as node")
            .select("node.session_key")
            .whereRef("node.session_key", "=", "session_canonical_validation_pending.session_key")
            .where("node.current_session_id", "=", regularRow.current_session_id)
            .where("node.entry_json", "=", regularRow.entry_json)
            .where("node.entry_valid", "=", 1)
            .where("node.parent_session_key", "is", regularRow.parent_session_key)
            .where("node.spawned_by", "is", regularRow.spawned_by)
            .where("node.fork_source_session_key", "is", regularRow.fork_source_session_key),
        ),
      ),
  );
}

/** Canonical writers certify their final rows within their existing transaction. */
export function certifyCanonicalSessionValidationRows(
  database: ValidationDatabase,
  sessionKeys: readonly string[],
): void {
  // Low-level autocommit callers leave invalidation work for the readiness owner.
  if (
    !database.db.isTransaction ||
    !hasCanonicalSessionValidationProjection(database) ||
    sessionKeys.length === 0
  ) {
    return;
  }
  const keys = [...new Set(sessionKeys)];
  const rows = executeSqliteQuerySync(
    database.db,
    canonicalSessionValidationQuery(database, { fullEntries: true }).where(
      "session_nodes.session_key",
      "in",
      sqliteStringSet(keys),
    ),
  ).rows;
  const found = new Set(rows.map((row) => row.session_key));
  const batch = validateCanonicalSessionValidationBatch({
    mainKey: readCanonicalSessionMainKey(database),
    rows,
    absentKeys: keys.filter((key) => !found.has(key)),
    hasMore: false,
    oversizedRows: 0,
  });
  // These rows were just reread and validated without yielding under the same reservation.
  executeSqliteQuerySync(
    database.db,
    getNodeSqliteKysely<PendingDatabase>(database.db)
      .deleteFrom("session_canonical_validation_pending")
      .where(
        "session_key",
        "in",
        sqliteStringSet([...batch.rows.map((row) => row.session_key), ...batch.absentKeys]),
      ),
  );
}
