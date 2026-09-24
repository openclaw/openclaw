import type { DatabaseSync } from "node:sqlite";
import { assertSqliteIntegrity } from "./sqlite-integrity.js";
import { quoteSqliteIdentifier } from "./sqlite-schema-sql.js";
import { runSqliteImmediateTransactionSync } from "./sqlite-transaction.js";

/** Explicit maintenance only: preserve the damaged image before rebuilding derived indexes. */
export function repairSqliteIndexCorruption(
  database: DatabaseSync,
  pathname: string,
  options: { backup: () => void; assertCurrent: () => void },
): string[] {
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
      const repaired = [...names].toSorted();
      for (const name of repaired) {
        database.exec(`REINDEX main.${quoteSqliteIdentifier(name)}`);
      }
      // Foreign-key checks use parent indexes, so corrupt keys can look like
      // missing parent rows until REINDEX. Real violations still roll back repair.
      assertSqliteIntegrity(database, pathname);
      return repaired;
    },
    {
      withCommit: (commit) => {
        options.assertCurrent();
        commit();
      },
    },
  );
}
