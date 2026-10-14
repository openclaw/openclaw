import fs from "node:fs/promises";
import { sha256File } from "./directory-durability.js";
import { openNodeSqliteDatabase } from "./node-sqlite.js";
import { copySqliteFile } from "./sqlite-file-copy.js";
import { assertSqliteIntegrity } from "./sqlite-integrity.js";
import { withPreparedSqliteSnapshot } from "./sqlite-readonly-location-cleanup.js";
import { prepareSqliteReadOnlyCopyInProcess } from "./sqlite-readonly-location.js";
import {
  assertSqliteSchemaContains,
  createSqliteTableContractReader,
} from "./sqlite-schema-contract.js";
import { quoteSqliteIdentifier } from "./sqlite-schema-sql.js";
import { readSqliteUserVersion } from "./sqlite-user-version.js";
import type { UpdateDatabaseBackup } from "./update-database-backup.js";
import { updateRunLedgerSchema } from "./update-run-write.js";

/** Runs only in the inspection child; the parent keeps native exclusion until publication. */
export async function prepareUpdateDatabaseRestoreSourceInProcess(params: {
  baseline: UpdateDatabaseBackup["databases"][number];
  currentPath: string;
  targetPath: string;
  stagingRoot: string;
}): Promise<{ sha256: string; sizeBytes: number; userVersion: number }> {
  // Copy the physical family: opening the live database would contend with the parent's exclusion.
  const snapshot = await prepareSqliteReadOnlyCopyInProcess(params.currentPath, params.stagingRoot);
  return await withPreparedSqliteSnapshot(snapshot, async (location) => {
    const current = openNodeSqliteDatabase(location, { readOnly: true });
    try {
      await copySqliteFile(
        params.baseline.snapshotPath,
        params.targetPath,
        await fs.lstat(params.baseline.snapshotPath, { bigint: true }),
      );
      const copied = await sha256File(params.targetPath);
      if (copied.digest !== params.baseline.sha256 || copied.bytes !== params.baseline.sizeBytes) {
        throw new Error(`Database snapshot changed: ${params.baseline.snapshotPath}`);
      }
      await fs.chmod(params.targetPath, 0o600);
      const target = openNodeSqliteDatabase(params.targetPath);
      let userVersion: number;
      try {
        userVersion = readSqliteUserVersion(target);
        if (userVersion !== params.baseline.userVersion) {
          throw new Error(`Database snapshot version changed: ${params.baseline.snapshotPath}`);
        }
        target.exec("PRAGMA journal_mode=DELETE");
        const historyObject = "SELECT 1 FROM sqlite_schema WHERE name = 'update_runs'";
        if (current.prepare(historyObject).get() || target.prepare(historyObject).get()) {
          assertSqliteSchemaContains(current, params.currentPath, updateRunLedgerSchema);
          assertSqliteSchemaContains(target, params.targetPath, updateRunLedgerSchema);
          const contract = createSqliteTableContractReader(current)("update_runs");
          if (!contract?.definition) {
            throw new Error("Update history has no admitted table contract.");
          }
          const columns = [...contract.definition.columns.keys()];
          const selected = columns.map(quoteSqliteIdentifier).join(", ");
          const rows = current.prepare(
            `SELECT rowid AS restore_rowid, ${selected} FROM update_runs`,
          );
          rows.setReadBigInts(true);
          const placeholders = Array.from({ length: columns.length + 1 }, () => "?").join(", ");
          const insert = target.prepare(
            `INSERT INTO update_runs (rowid, ${selected}) VALUES (${placeholders})`,
          );
          target.exec("BEGIN IMMEDIATE");
          try {
            // Copy raw history, including rowids and opaque JSON; bounded readers/codecs lose facts.
            target.exec("DELETE FROM update_runs");
            for (const row of rows.iterate()) {
              insert.run(row.restore_rowid!, ...columns.map((column) => row[column]!));
            }
            target.exec("COMMIT");
          } catch (error) {
            target.exec("ROLLBACK");
            throw error;
          }
        }
        assertSqliteIntegrity(target, params.targetPath);
      } finally {
        target.close();
      }
      const output = await fs.open(params.targetPath, "r+");
      try {
        await output.sync();
        const content = await sha256File(output);
        return { sha256: content.digest, sizeBytes: content.bytes, userVersion };
      } finally {
        await output.close();
      }
    } finally {
      current.close();
    }
  });
}
