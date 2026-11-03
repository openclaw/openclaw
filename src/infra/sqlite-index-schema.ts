import { performance } from "node:perf_hooks";
import type { DatabaseSync } from "node:sqlite";
import {
  assertSqliteIntegrity,
  assertSqliteTableIntegrity,
  classifySqliteFtsIntegrityFindings,
  isTerminalSqliteIntegrityError,
  readSqliteIntegrityFindings,
  sqliteIntegrityCheckSteps,
  type SqliteIntegrityCheckOptions,
  type SqliteIntegrityDiagnostics,
  type SqliteIntegrityOperation,
} from "./sqlite-integrity.js";
import { runSqliteSchemaReadSnapshotSync } from "./sqlite-pinned-read-snapshot.js";
import {
  createSqliteTableContractReader,
  getCanonicalSqliteNamedIndexContracts,
  getCanonicalSqliteTableNames,
  hasCanonicalSqliteSchemaFingerprint,
  type CanonicalSqliteNamedIndexContract,
  type SqliteSchemaSource,
  type SqliteTableContractReader,
} from "./sqlite-schema-contract.js";
import { isSqliteSchemaMismatchError, SqliteSchemaMismatchError } from "./sqlite-schema-issues.js";
import { quoteSqliteIdentifier } from "./sqlite-schema-sql.js";
import { runSqliteImmediateTransactionSync } from "./sqlite-transaction.js";

const SQLITE_IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/u;

type RepairCanonicalSqliteIndexesOptions = {
  /**
   * A recognized schema migration may add a column before recreating its
   * canonical index. No other repair failure is deferred.
   */
  allowMissingColumns?: boolean;
  /** Bounded startup admission may rebuild projections, never uniqueness constraints. */
  nonUniqueOnly?: boolean;
  /** Keep index repair atomic with the caller's whole-schema validation. */
  validateAfterRepair?: () => void;
  /** Reuse the inspection catalog only while its unchanged snapshot is still pinned. */
  validateUnchanged?: (readTable?: SqliteTableContractReader) => void;
  verifyPhysicalIntegrity?: boolean;
  integrity?: SqliteIntegrityCheckOptions;
};

/**
 * Verify the whole file before schema convergence. Physical corruption belongs
 * to explicit Doctor maintenance, including when only an index is damaged.
 */
export function* verifyAndRepairCanonicalSqliteIndexSteps(
  db: DatabaseSync,
  databaseLabel: string,
  schemaSql: SqliteSchemaSource,
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
    yield* sqliteIntegrityCheckSteps(db, databaseLabel, diagnostics, options.integrity);
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
  schemaSql: SqliteSchemaSource,
  options: RepairCanonicalSqliteIndexesOptions = {},
): string[] {
  const repairIndexes = new Set<CanonicalSqliteNamedIndexContract>();
  // One read snapshot also avoids a network lock round trip per metadata query.
  runSqliteSchemaReadSnapshotSync(db, () => {
    const readTable = createSqliteTableContractReader(db);
    if (!hasCanonicalSqliteSchemaFingerprint(schemaSql, readTable)) {
      const indexes = getCanonicalSqliteNamedIndexContracts(schemaSql);
      const indexesByTable = new Map<string, CanonicalSqliteNamedIndexContract[]>();
      for (const index of indexes) {
        assertSqliteIdentifier(index.name);
        assertSqliteIdentifier(index.tableName);
        const tableIndexes = indexesByTable.get(index.tableName) ?? [];
        tableIndexes.push(index);
        indexesByTable.set(index.tableName, tableIndexes);
      }
      for (const tableName of getCanonicalSqliteTableNames(schemaSql)) {
        assertSqliteIdentifier(tableName);
        const table = readTable(tableName);
        if (!table) {
          continue;
        }
        const tableIndexes = indexesByTable.get(tableName) ?? [];
        const canonicalIndexNames = new Set(tableIndexes.map((index) => index.name));
        const actualIndexes = table.indexes;
        const unexpected = actualIndexes.find(
          (index) =>
            index.unique === 1 &&
            index.origin === "c" &&
            index.name !== null &&
            !canonicalIndexNames.has(index.name),
        );
        if (unexpected) {
          throw new SqliteSchemaMismatchError(
            `SQLite schema is incomplete or noncanonical for ${databaseLabel}: unexpected unique index ${unexpected.name}`,
          );
        }
        for (const index of tableIndexes) {
          const actual = actualIndexes.find((candidate) => candidate.name === index.name);
          if (JSON.stringify(actual) !== JSON.stringify(index.fingerprint)) {
            if (options.nonUniqueOnly && (index.unique || actual?.unique === 1)) {
              throw new SqliteSchemaMismatchError(
                `Canonical unique index ${index.name} requires full admission`,
              );
            }
            repairIndexes.add(index);
          }
        }
      }
    }

    if (options.verifyPhysicalIntegrity !== false) {
      assertSqliteIntegrity(db, databaseLabel, options.integrity);
    }
    if (repairIndexes.size === 0) {
      options.validateUnchanged?.(readTable);
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
      // Transactional DDL preserves the old index on failure or process death;
      // a probe would build the same index twice. Isolate skipped migrations too.
      db.exec("SAVEPOINT repair_canonical_index;");
      try {
        db.exec(`DROP INDEX IF EXISTS main.${index.name};`);
        const create = index.unique ? "CREATE UNIQUE INDEX" : "CREATE INDEX";
        db.exec(`${create} main.${index.name} ${index.definition};`);
      } catch (error) {
        db.exec("ROLLBACK TO SAVEPOINT repair_canonical_index;");
        if (options.allowMissingColumns && isMissingColumnError(error)) {
          repairIndexes.delete(index);
          continue;
        }
        throw error;
      } finally {
        db.exec("RELEASE SAVEPOINT repair_canonical_index;");
      }
    }
    if (repairIndexes.size === 0) {
      // Skipped column migrations rolled back DDL after the inspection snapshot ended.
      options.validateUnchanged?.();
      db.exec(`RELEASE SAVEPOINT ${savepoint};`);
      return [];
    }
    // Index-only DDL verifies touched tables without another whole-file scan.
    for (const table of new Set([...repairIndexes].map((index) => index.tableName))) {
      assertSqliteTableIntegrity(db, databaseLabel, table);
    }
    options.validateAfterRepair?.();
    db.exec(`RELEASE SAVEPOINT ${savepoint};`);
  } catch (error) {
    try {
      db.exec(`ROLLBACK TO SAVEPOINT ${savepoint};`);
    } finally {
      db.exec(`RELEASE SAVEPOINT ${savepoint};`);
    }
    if (
      isSqliteSchemaMismatchError(error) ||
      (error instanceof Error && isTerminalSqliteIntegrityError(error))
    ) {
      throw error;
    }
    const detail = error instanceof Error ? error.message : String(error);
    if (options.nonUniqueOnly && isMissingColumnError(error)) {
      throw new SqliteSchemaMismatchError(detail, { cause: error });
    }
    throw new Error(
      `SQLite canonical index ${activeIndex?.name ?? "repair"} failed for ${databaseLabel}: ${detail}`,
      { cause: error },
    );
  }
  return [...repairIndexes].map((index) => index.name).toSorted();
}

type SqliteIndexCorruptionPlan = {
  indexes: string[];
  fts: boolean;
};

type IndexCorruptionInspectionOptions = {
  ftsSchemas?: readonly string[];
  ftsOnly?: boolean;
};

/** The maintenance owner keeps exclusive custody until the inspected plan is applied. */
export function inspectSqliteIndexCorruption(
  database: DatabaseSync,
  pathname: string,
  options: IndexCorruptionInspectionOptions,
): SqliteIndexCorruptionPlan {
  return runSqliteSchemaReadSnapshotSync(database, () => {
    const names = new Set<string>();
    // Inspect every finding: SQLite's default 100-row limit can hide later damage.
    const findings = readSqliteIntegrityFindings(database);
    const ftsTables = classifySqliteFtsIntegrityFindings(
      database,
      findings,
      options.ftsSchemas ?? [],
    );
    if (options.ftsOnly && !ftsTables) {
      throw new Error("Startup repair requires only canonical FTS integrity findings");
    }
    for (const finding of ftsTables ? [] : findings) {
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
    return { indexes: ftsTables ?? [...names].toSorted(), fts: ftsTables !== undefined };
  });
}

function runIndexCorruptionRepair(
  database: DatabaseSync,
  pathname: string,
  inspect: () => SqliteIndexCorruptionPlan,
  options: { backup: () => void; assertCurrent: () => void },
): string[] {
  let repaired: string[] = [];
  return runSqliteImmediateTransactionSync(
    database,
    () => {
      const plan = inspect();
      if (plan.indexes.length === 0) {
        return [];
      }
      options.backup();
      repaired = plan.indexes;
      for (const name of repaired) {
        const identifier = quoteSqliteIdentifier(name);
        database.exec(
          plan.fts
            ? `INSERT INTO main.${identifier}(${identifier}) VALUES('rebuild')`
            : `REINDEX main.${identifier}`,
        );
      }
      // Real foreign-key violations still roll the repair back after parent indexes are rebuilt.
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

/** Apply a preserved plan only while its original maintenance owner is still current. */
export function applySqliteIndexCorruptionRepair(
  database: DatabaseSync,
  pathname: string,
  plan: SqliteIndexCorruptionPlan,
  assertCurrent: () => void,
): string[] {
  return runIndexCorruptionRepair(
    database,
    pathname,
    () => {
      assertCurrent();
      return plan;
    },
    { backup: () => {}, assertCurrent },
  );
}

/** Synchronous SDK/native startup callers retain one transaction through preservation. */
export function repairSqliteIndexCorruption(
  database: DatabaseSync,
  pathname: string,
  options: IndexCorruptionInspectionOptions & { backup: () => void; assertCurrent: () => void },
): string[] {
  return runIndexCorruptionRepair(
    database,
    pathname,
    () => inspectSqliteIndexCorruption(database, pathname, options),
    options,
  );
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
