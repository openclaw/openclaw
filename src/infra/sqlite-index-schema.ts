import { performance } from "node:perf_hooks";
import type { DatabaseSync } from "node:sqlite";
import {
  assertSqliteIntegrity,
  assertSqliteTableIntegrity,
  isTerminalSqliteIntegrityError,
  runSqliteIntegrityOperationSync,
  sqliteIntegrityCheckSteps,
  type SqliteIntegrityDiagnostics,
  type SqliteIntegrityOperation,
} from "./sqlite-integrity.js";
import { runSqlitePinnedReadSnapshotSync } from "./sqlite-pinned-read-snapshot.js";
import type { SqliteIndexListRow } from "./sqlite-schema-contract-assembly.js";
import {
  collectSqliteNamedIndexContract,
  getCanonicalSqliteNamedIndexContracts,
  getCanonicalSqliteTableNames,
  type CanonicalSqliteNamedIndexContract,
} from "./sqlite-schema-contract.js";
import { quoteSqliteIdentifier } from "./sqlite-schema-sql.js";
import { runSqliteImmediateTransactionSync } from "./sqlite-transaction.js";

const SQLITE_IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/u;

type RepairCanonicalSqliteIndexesOptions = {
  /**
   * A recognized schema migration may add a column before recreating its
   * canonical index. No other repair failure is deferred.
   */
  allowMissingColumns?: boolean;
  /** Keep index repair atomic with the caller's whole-schema validation. */
  validateAfterRepair?: () => void;
  verifyPhysicalIntegrity?: boolean;
};

/**
 * Verify the whole file before schema convergence. Physical corruption belongs
 * to explicit Doctor maintenance, including when only an index is damaged.
 */
export function verifyAndRepairCanonicalSqliteIndexes(
  db: DatabaseSync,
  databaseLabel: string,
  schemaSql: string,
  options: Omit<RepairCanonicalSqliteIndexesOptions, "verifyPhysicalIntegrity"> = {},
): string[] {
  return runSqliteIntegrityOperationSync(
    verifyAndRepairCanonicalSqliteIndexSteps(db, databaseLabel, schemaSql, options),
  );
}

export function* verifyAndRepairCanonicalSqliteIndexSteps(
  db: DatabaseSync,
  databaseLabel: string,
  schemaSql: string,
  options: Omit<RepairCanonicalSqliteIndexesOptions, "verifyPhysicalIntegrity"> & {
    diagnostics?: SqliteIntegrityDiagnostics;
    reuseIntegrity?: boolean;
  } = {},
): SqliteIntegrityOperation<string[]> {
  const { diagnostics, reuseIntegrity, ...repairOptions } = options;
  if (reuseIntegrity) {
    if (diagnostics) {
      diagnostics.integrityGateOutcome = "cached";
    }
  } else {
    yield* sqliteIntegrityCheckSteps(db, databaseLabel, diagnostics);
  }

  const indexesStartedAt = performance.now();
  const repairedIndexes = repairCanonicalSqliteIndexes(db, databaseLabel, schemaSql, {
    ...repairOptions,
    verifyPhysicalIntegrity: false,
  });
  if (diagnostics) {
    diagnostics.canonicalIndexMs = Math.floor(performance.now() - indexesStartedAt);
    diagnostics.repairedIndexCount = repairedIndexes.length;
  }
  return repairedIndexes;
}

/**
 * Restore every named index when SQLite's IF NOT EXISTS semantics preserve a
 * same-name definition that no longer matches the committed schema.
 */
export function repairCanonicalSqliteIndexes(
  db: DatabaseSync,
  databaseLabel: string,
  schemaSql: string,
  options: RepairCanonicalSqliteIndexesOptions = {},
): string[] {
  const indexes = getCanonicalSqliteNamedIndexContracts(schemaSql);
  const indexesByTable = new Map<string, CanonicalSqliteNamedIndexContract[]>();
  const repairIndexes = new Set<CanonicalSqliteNamedIndexContract>();
  // One read snapshot also avoids a network lock round trip per metadata query.
  runSqlitePinnedReadSnapshotSync(db, () => {
    for (const index of indexes) {
      assertSqliteIdentifier(index.name);
      assertSqliteIdentifier(index.tableName);
      const tableExists = db
        .prepare("SELECT 1 FROM main.sqlite_schema WHERE type = 'table' AND name = ?")
        .get(index.tableName);
      if (!tableExists) {
        continue;
      }
      const tableIndexes = indexesByTable.get(index.tableName) ?? [];
      tableIndexes.push(index);
      indexesByTable.set(index.tableName, tableIndexes);
      const actual = collectSqliteNamedIndexContract(db, index.name);
      if (JSON.stringify(actual) !== JSON.stringify(index.fingerprint)) {
        repairIndexes.add(index);
      }
    }
    assertNoUnexpectedUniqueIndexes(db, databaseLabel, schemaSql, indexesByTable);

    if (options.verifyPhysicalIntegrity !== false) {
      assertSqliteIntegrity(db, databaseLabel);
    }
  });
  if (repairIndexes.size === 0) {
    return [];
  }

  const savepoint = "repair_canonical_indexes";
  let activeIndex: CanonicalSqliteNamedIndexContract | undefined;
  db.exec(`SAVEPOINT ${savepoint};`);
  try {
    for (const index of repairIndexes) {
      activeIndex = index;
      const probeName = findUnusedProbeIndexName(db, index.name);
      // Build the canonical constraint first. If existing rows conflict, the
      // wrong same-name index remains in place and the whole repair rolls back.
      try {
        db.exec(createIndexSql(index, probeName));
      } catch (error) {
        if (options.allowMissingColumns && isMissingColumnError(error)) {
          repairIndexes.delete(index);
          continue;
        }
        throw error;
      }
      db.exec(`DROP INDEX IF EXISTS main.${index.name};`);
      db.exec(createIndexSql(index, index.name));
      db.exec(`DROP INDEX main.${probeName};`);
    }
    if (repairIndexes.size === 0) {
      db.exec(`RELEASE SAVEPOINT ${savepoint};`);
      return [];
    }
    for (const tableName of indexesByTable.keys()) {
      assertSqliteTableIntegrity(db, databaseLabel, tableName);
    }
    assertSqliteIntegrity(db, databaseLabel);
    options.validateAfterRepair?.();
    db.exec(`RELEASE SAVEPOINT ${savepoint};`);
  } catch (error) {
    try {
      db.exec(`ROLLBACK TO SAVEPOINT ${savepoint};`);
    } finally {
      db.exec(`RELEASE SAVEPOINT ${savepoint};`);
    }
    if (error instanceof Error && isTerminalSqliteIntegrityError(error)) {
      throw error;
    }
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `SQLite canonical index ${activeIndex?.name ?? "repair"} failed for ${databaseLabel}: ${detail}`,
      { cause: error },
    );
  }
  return [...repairIndexes].map((index) => index.name).toSorted();
}

/** Explicit maintenance only: preserve the damaged image before rebuilding derived indexes. */
export function repairSqliteIndexCorruption(
  database: DatabaseSync,
  pathname: string,
  options: { backup: () => void; assertCurrent: () => void },
): string[] {
  let repaired: string[] = [];
  return runSqliteImmediateTransactionSync(
    database,
    () => {
      const names = new Set<string>();
      // Stream every finding: SQLite's default 100-row limit can hide later damage.
      for (const row of database.prepare("PRAGMA integrity_check(2147483647)").iterate()) {
        const finding = row.integrity_check;
        if (finding === "ok") {
          continue;
        }
        const match =
          typeof finding === "string"
            ? /^(?:row \d+ missing from index|wrong # of entries in index|non-unique entry in index) (.+)$/u.exec(
                finding,
              )
            : null;
        const name = match?.[1];
        if (!name) {
          throw new Error(`Unrecognized SQLite integrity finding: ${String(finding)}`);
        }
        names.add(name);
      }
      if (names.size === 0) {
        return [];
      }

      const tables = new Set<string>();
      for (const name of names) {
        const index = database
          .prepare("SELECT tbl_name FROM main.sqlite_schema WHERE type = 'index' AND name = ?")
          .get(name);
        if (typeof index?.tbl_name !== "string") {
          throw new Error(`SQLite index repair refused unknown index ${name} for ${pathname}.`);
        }
        tables.add(index.tbl_name);
      }
      for (const table of tables) {
        const statement = database.prepare(
          `SELECT * FROM main.${quoteSqliteIdentifier(table)} NOT INDEXED`,
        );
        statement.setReadBigInts(true);
        const rows = statement.iterate();
        while (!rows.next().done) {
          // Reading every value also verifies overflow pages without using a damaged index.
        }
      }

      options.backup();
      repaired = [...names].toSorted();
      for (const name of repaired) {
        database.exec(`REINDEX main.${quoteSqliteIdentifier(name)}`);
      }
      // Foreign-key checks use parent indexes, so corrupt keys can look like
      // missing parent rows until REINDEX. Real violations still roll back repair.
      assertSqliteIntegrity(database, pathname);
      return repaired;
    },
    {
      databaseLabel: pathname,
      operationLabel: "sqlite.index-corruption-repair",
      withCommit: (commit) => {
        if (repaired.length > 0) {
          options.assertCurrent();
        }
        commit();
      },
    },
  );
}

function assertNoUnexpectedUniqueIndexes(
  db: DatabaseSync,
  databaseLabel: string,
  schemaSql: string,
  indexesByTable: ReadonlyMap<string, readonly CanonicalSqliteNamedIndexContract[]>,
): void {
  for (const tableName of getCanonicalSqliteTableNames(schemaSql)) {
    assertSqliteIdentifier(tableName);
    const tableExists = db
      .prepare("SELECT 1 FROM main.sqlite_schema WHERE type = 'table' AND name = ?")
      .get(tableName);
    if (!tableExists) {
      continue;
    }
    const canonicalIndexNames = new Set(
      (indexesByTable.get(tableName) ?? []).map((index) => index.name),
    );
    const unexpected = (
      db.prepare(`PRAGMA main.index_list(${tableName})`).all() as SqliteIndexListRow[]
    ).find(
      (index) => index.unique === 1 && index.origin === "c" && !canonicalIndexNames.has(index.name),
    );
    if (unexpected) {
      throw new Error(
        `SQLite schema is incomplete or noncanonical for ${databaseLabel}: unexpected unique index ${unexpected.name}`,
      );
    }
  }
}

function createIndexSql(index: CanonicalSqliteNamedIndexContract, name: string): string {
  assertSqliteIdentifier(name);
  const create = index.unique ? "CREATE UNIQUE INDEX" : "CREATE INDEX";
  return `${create} main.${name} ${index.definition};`;
}

function findUnusedProbeIndexName(db: DatabaseSync, canonicalName: string): string {
  const prefix = `openclaw_probe_${canonicalName}`;
  for (let suffix = 0; suffix < 100; suffix += 1) {
    const candidate = suffix === 0 ? prefix : `${prefix}_${suffix}`;
    const row = db
      .prepare("SELECT 1 AS found FROM main.sqlite_schema WHERE name = ?")
      .get(candidate);
    if (!row) {
      return candidate;
    }
  }
  throw new Error(`could not allocate a probe index name for ${canonicalName}`);
}

function assertSqliteIdentifier(identifier: string): void {
  if (!SQLITE_IDENTIFIER_PATTERN.test(identifier)) {
    throw new Error(`invalid SQLite identifier: ${identifier}`);
  }
}

function isMissingColumnError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error as NodeJS.ErrnoException).code === "ERR_SQLITE_ERROR" &&
    /^no such column:/iu.test(error.message)
  );
}
