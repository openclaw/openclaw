import type { DatabaseSync } from "node:sqlite";
import { runExistingOpenClawStateWriteTransaction } from "../../state/openclaw-state-db-existing-write.js";
import { withExistingOpenClawStateDatabaseArtifactPreservingReadOnly } from "../../state/openclaw-state-db-readonly.js";
import { tableExists } from "../../state/openclaw-state-db-schema-helpers.js";
import type { DB } from "../../state/openclaw-state-db.generated.js";
import { OPENCLAW_STATE_SCHEMA_SQL } from "../../state/openclaw-state-schema.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../kysely-sync.js";
import type { SqliteReadOnlyOperationContext } from "../sqlite-readonly-operation-types.js";
import { extractSqliteTableSchema } from "../sqlite-schema-sql.js";
import { readUpdateRunRecord } from "../update-run-read.kernel.js";
import { updateRunLedgerSchema } from "../update-run-write.js";
import {
  upgradeRecipeMaintenanceBindingSchema,
  upgradeRecipeMaintenanceReceiptSchema,
  type UpgradeRecipeMaintenanceReceipt,
  type UpgradeRecipeMaintenanceWriteInput,
} from "./maintenance-contract.js";

// One conflict owner per selected shared-state family. This is operational evidence,
// not a second execution lease; all writes retain the existing update fence.
const RECEIPT_KEY = "update.recipe-maintenance.active";
const maintenanceSchema = `${updateRunLedgerSchema}\n${extractSqliteTableSchema(OPENCLAW_STATE_SCHEMA_SQL, "config_machine_state")}`;
type MaintenanceDatabase = Pick<DB, "config_machine_state">;

export function readUpgradeRecipeMaintenanceReceiptInDatabase(
  db: DatabaseSync,
): UpgradeRecipeMaintenanceReceipt | null {
  if (!tableExists(db, "config_machine_state")) {
    return null;
  }
  const row = executeSqliteQueryTakeFirstSync(
    db,
    getNodeSqliteKysely<MaintenanceDatabase>(db)
      .selectFrom("config_machine_state")
      .select("value_json")
      .where("state_key", "=", RECEIPT_KEY),
  );
  // Corruption is a refusal, never equivalent to an absent gate.
  return row ? upgradeRecipeMaintenanceReceiptSchema.parse(JSON.parse(row.value_json)) : null;
}

export const upgradeMaintenanceReadOperations = {
  "upgradeMaintenance.read": (_input: undefined, context: SqliteReadOnlyOperationContext) =>
    withExistingOpenClawStateDatabaseArtifactPreservingReadOnly(
      ({ db }) => readUpgradeRecipeMaintenanceReceiptInDatabase(db),
      context,
    ) ?? null,
};

export function recordUpgradeRecipeMaintenanceInWorker(
  input: UpgradeRecipeMaintenanceWriteInput,
  options: { path: string; env: NodeJS.ProcessEnv },
  assertCurrent: (stage: "transaction" | "commit") => void,
): UpgradeRecipeMaintenanceReceipt {
  const binding = upgradeRecipeMaintenanceBindingSchema.parse(input.binding);
  return runExistingOpenClawStateWriteTransaction(
    ({ db }) => {
      assertCurrent("transaction");
      const run = readUpdateRunRecord(db, binding.runId);
      if (!run || run.status !== "running") {
        throw new Error("Upgrade maintenance requires its running update owner.");
      }
      const current = readUpgradeRecipeMaintenanceReceiptInDatabase(db);
      if ((current?.revision ?? null) !== input.expectedRevision) {
        throw new Error("Upgrade maintenance receipt changed.");
      }
      const sameBinding = current && JSON.stringify(current.binding) === JSON.stringify(binding);
      const allowed =
        input.phase === "maintenance-required"
          ? !current || (current.phase === "committed" && current.binding.runId !== binding.runId)
          : sameBinding &&
            (input.phase === "commit-intent"
              ? current.phase === "maintenance-required"
              : current.phase === "commit-intent");
      if (!allowed) {
        throw new Error("Upgrade maintenance transition is not admitted.");
      }
      const receipt = upgradeRecipeMaintenanceReceiptSchema.parse({
        binding,
        phase: input.phase,
        revision: (current?.revision ?? 0) + 1,
        updatedAtMs: Date.now(),
      });
      const row = {
        state_key: RECEIPT_KEY,
        value_json: JSON.stringify(receipt),
        updated_at_ms: receipt.updatedAtMs,
      };
      const queries = getNodeSqliteKysely<MaintenanceDatabase>(db);
      if (current) {
        const changed = executeSqliteQuerySync(
          db,
          queries
            .updateTable("config_machine_state")
            .set(row)
            .where("state_key", "=", RECEIPT_KEY)
            .where("value_json", "=", JSON.stringify(current)),
        );
        if (changed.numAffectedRows !== 1n) {
          throw new Error("Upgrade maintenance receipt changed during commit.");
        }
      } else {
        executeSqliteQuerySync(db, queries.insertInto("config_machine_state").values(row));
      }
      assertCurrent("commit");
      return receipt;
    },
    options,
    { schemaSql: maintenanceSchema, operationLabel: "upgrade.recipe-maintenance" },
  );
}

export const upgradeMaintenanceStateReadOperations = {
  "upgradeMaintenance.read": (_input: undefined, db: DatabaseSync) => ({
    type: "upgradeMaintenance.read" as const,
    receipt: readUpgradeRecipeMaintenanceReceiptInDatabase(db),
  }),
};
