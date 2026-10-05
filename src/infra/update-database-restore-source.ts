import fs from "node:fs/promises";
import { OPENCLAW_STATE_SCHEMA_SQL } from "../state/openclaw-state-schema.js";
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
import { extractSqliteTableSchema, quoteSqliteIdentifier } from "./sqlite-schema-sql.js";
import { readSqliteUserVersion } from "./sqlite-user-version.js";
import type { UpdateDatabaseBackup } from "./update-database-backup.js";
import { updateRunLedgerSchema } from "./update-run-write.js";
import { assertUpgradeRecipeReceiptRollbackAllowed } from "./upgrade-recipes/maintenance-contract.js";
import { readUpgradeRecipeMaintenanceReceiptInDatabase } from "./upgrade-recipes/maintenance-store.js";

/** Runs only in the inspection child; the parent keeps native exclusion until publication. */
export async function prepareUpdateDatabaseRestoreSourceInProcess(params: {
  baseline: UpdateDatabaseBackup["databases"][number];
  currentPath: string;
  targetPath: string;
  stagingRoot: string;
  runId?: string;
}): Promise<{ sha256: string; sizeBytes: number; userVersion: number }> {
  // Copy the physical family: opening the live database would contend with the parent's exclusion.
  const snapshot = await prepareSqliteReadOnlyCopyInProcess(params.currentPath, params.stagingRoot);
  return await withPreparedSqliteSnapshot(snapshot, async (location) => {
    const current = openNodeSqliteDatabase(location, { readOnly: true });
    try {
      assertUpgradeRecipeReceiptRollbackAllowed(
        readUpgradeRecipeMaintenanceReceiptInDatabase(current),
        params.runId,
      );
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
          const insert = target.prepare(
            `INSERT INTO update_runs (rowid, ${selected}) VALUES (${columns
              .map(() => "?")
              .concat("?")
              .join(", ")})`,
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
        // Recipe receipts are operational recovery evidence, not baseline application state.
        // Preserve their raw values so compensation cannot erase an intent or permit replay.
        const recipeSchema = extractSqliteTableSchema(
          OPENCLAW_STATE_SCHEMA_SQL,
          "config_machine_state",
        );
        const machineTable = "SELECT 1 FROM sqlite_schema WHERE name = 'config_machine_state'";
        const currentMachine = current.prepare(machineTable).get();
        const targetMachine = target.prepare(machineTable).get();
        if (currentMachine || targetMachine) {
          if (currentMachine) {
            assertSqliteSchemaContains(current, params.currentPath, recipeSchema);
          }
          if (!targetMachine) {
            target.exec(recipeSchema);
          }
          assertSqliteSchemaContains(target, params.targetPath, recipeSchema);
          const rows = currentMachine
            ? current.prepare(
                "SELECT state_key, value_json, updated_at_ms FROM config_machine_state WHERE substr(state_key, 1, 14) = 'update.recipe-'",
              )
            : undefined;
          rows?.setReadBigInts(true);
          const insert = target.prepare(
            "INSERT INTO config_machine_state (state_key, value_json, updated_at_ms) VALUES (?, ?, ?)",
          );
          target.exec("BEGIN IMMEDIATE");
          try {
            target.exec(
              "DELETE FROM config_machine_state WHERE substr(state_key, 1, 14) = 'update.recipe-'",
            );
            for (const row of rows?.iterate() ?? []) {
              insert.run(row.state_key!, row.value_json!, row.updated_at_ms!);
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
