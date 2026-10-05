import { createHash } from "node:crypto";
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
  parseUpgradeRecipeStepBinding,
  upgradeRecipeStepObservationSchema,
  upgradeRecipeStepPostconditionMatches,
  upgradeRecipeStepReceiptSchema,
  upgradeRecipeStepWriteInputSchema,
  type UpgradeRecipeStepBinding,
  type UpgradeRecipeStepReceipt,
  type UpgradeRecipeStepWriteInput,
} from "./receipts-contract.js";

const receiptSchema = `${updateRunLedgerSchema}\n${extractSqliteTableSchema(OPENCLAW_STATE_SCHEMA_SQL, "config_machine_state")}`;
type ReceiptDatabase = Pick<DB, "config_machine_state">;
function receiptKey(binding: UpgradeRecipeStepBinding): string {
  // Run and step select the historical record; a changed plan must not create a fresh intent.
  return `update.recipe-step.${createHash("sha256")
    .update(JSON.stringify([binding.runId, binding.stepId]))
    .digest("hex")}`;
}

export function readUpgradeRecipeStepReceiptInDatabase(
  db: DatabaseSync,
  selected: UpgradeRecipeStepBinding,
): UpgradeRecipeStepReceipt | null {
  const binding = parseUpgradeRecipeStepBinding(selected);
  if (!tableExists(db, "config_machine_state")) {
    return null;
  }
  const row = executeSqliteQueryTakeFirstSync(
    db,
    getNodeSqliteKysely<ReceiptDatabase>(db)
      .selectFrom("config_machine_state")
      .select("value_json")
      .where("state_key", "=", receiptKey(binding)),
  );
  if (!row) {
    return null;
  }
  const receipt = upgradeRecipeStepReceiptSchema.parse(JSON.parse(row.value_json));
  if (JSON.stringify(receipt.binding) !== JSON.stringify(binding)) {
    throw new Error("Recipe step plan, adapter, or resource identity changed.");
  }
  return receipt;
}

export const upgradeRecipeStepReadOperations = {
  "upgradeRecipeSteps.read": (
    input: UpgradeRecipeStepBinding,
    context: SqliteReadOnlyOperationContext,
  ) =>
    withExistingOpenClawStateDatabaseArtifactPreservingReadOnly(
      ({ db }) => readUpgradeRecipeStepReceiptInDatabase(db, input),
      context,
    ) ?? null,
};

/** Existing updater's fenced transaction persists sidecar evidence, never a second execution owner. */
export function recordUpgradeRecipeStepInWorker(
  selected: UpgradeRecipeStepWriteInput,
  options: { path: string; env: NodeJS.ProcessEnv },
  assertCurrent: (stage: "transaction" | "commit") => void,
): UpgradeRecipeStepReceipt {
  const input = upgradeRecipeStepWriteInputSchema.parse(selected);
  const binding = parseUpgradeRecipeStepBinding(input.binding);
  const observation =
    input.kind === "observation"
      ? upgradeRecipeStepObservationSchema.parse(input.observation)
      : undefined;
  return runExistingOpenClawStateWriteTransaction(
    ({ db }) => {
      assertCurrent("transaction");
      const run = readUpdateRunRecord(db, binding.runId);
      if (!run || run.status !== "running") {
        throw new Error("Recipe step receipt requires its running update owner.");
      }
      const current = readUpgradeRecipeStepReceiptInDatabase(db, binding);
      if ((current?.revision ?? null) !== input.expectedRevision) {
        throw new Error(
          "Recipe step receipt changed; reconcile the retained outcome before continuing.",
        );
      }
      if (input.kind === "intent" ? current !== null : !current || current.phase === "verified") {
        throw new Error(
          "Recipe step transition is not admitted; retained intent never authorizes replay.",
        );
      }
      const now = Date.now();
      const receipt = upgradeRecipeStepReceiptSchema.parse({
        binding,
        phase: observation
          ? upgradeRecipeStepPostconditionMatches(binding, observation)
            ? "verified"
            : "outcome-unknown"
          : "intent",
        revision: (current?.revision ?? 0) + 1,
        intentAtMs: current?.intentAtMs ?? now,
        updatedAtMs: now,
        ...(observation ? { observation } : {}),
      });
      const queries = getNodeSqliteKysely<ReceiptDatabase>(db);
      const row = {
        state_key: receiptKey(binding),
        value_json: JSON.stringify(receipt),
        updated_at_ms: now,
      };
      if (current) {
        const changed = executeSqliteQuerySync(
          db,
          queries
            .updateTable("config_machine_state")
            .set(row)
            .where("state_key", "=", row.state_key)
            .where("value_json", "=", JSON.stringify(current)),
        );
        if (changed.numAffectedRows !== 1n) {
          throw new Error("Recipe step receipt changed during commit.");
        }
      } else {
        executeSqliteQuerySync(db, queries.insertInto("config_machine_state").values(row));
      }
      assertCurrent("commit");
      return receipt;
    },
    options,
    { schemaSql: receiptSchema, operationLabel: "upgrade.recipe-step" },
  );
}
