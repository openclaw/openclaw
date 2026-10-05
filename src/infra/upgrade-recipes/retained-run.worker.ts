import type { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
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
import { assertManagedUpdateLeaseDatabaseIdentity } from "../update-managed-service-handoff-database.js";
import { readUpdateRunRecord } from "../update-run-read.kernel.js";
import { updateRunLedgerSchema } from "../update-run-write.js";
import { pointerSchema, type RetainedUpgradeRecipeRunPointer } from "./retained-run-contract.js";

const schemaSql = `${updateRunLedgerSchema}\n${extractSqliteTableSchema(OPENCLAW_STATE_SCHEMA_SQL, "config_machine_state")}`;
const key = (runId: string) => `update.recipe-run.${z.uuid().parse(runId)}`;

type PointerDatabase = Pick<DB, "config_machine_state">;
export function readRetainedUpgradeRecipeRunInDatabase(db: DatabaseSync, runId: string) {
  const stateKey = key(runId);
  if (!tableExists(db, "config_machine_state") || !tableExists(db, "update_runs")) {
    return null;
  }
  const row = executeSqliteQueryTakeFirstSync(
    db,
    getNodeSqliteKysely<PointerDatabase>(db)
      .selectFrom("config_machine_state")
      .select("value_json")
      .where("state_key", "=", stateKey),
  );
  if (!row) {
    return null;
  }
  const pointer = pointerSchema.parse(JSON.parse(row.value_json));
  const run = readUpdateRunRecord(db, runId);
  if (!run || pointer.runId !== runId || run.createdAtMs !== pointer.originalCreatedAtMs) {
    throw new Error("Retained recipe evidence lost its original ledger correlation.");
  }
  return {
    runId,
    status: run.status,
    phase: run.phase,
    retainedEvidenceSha256: pointer.envelope.sha256,
    pointer,
  };
}
export const upgradeRecipeRetainedRunReadOperations = {
  "upgradeRecipeRuns.read": (input: { runId: string }, context: SqliteReadOnlyOperationContext) =>
    withExistingOpenClawStateDatabaseArtifactPreservingReadOnly(
      ({ db }) => readRetainedUpgradeRecipeRunInDatabase(db, input.runId),
      context,
    ) ?? null,
};
export function recordRetainedUpgradeRecipeRunInWorker(
  selected: RetainedUpgradeRecipeRunPointer,
  options: { path: string; env: NodeJS.ProcessEnv },
  assertCurrent: (stage: "transaction" | "commit") => void,
): RetainedUpgradeRecipeRunPointer {
  const pointer = pointerSchema.parse(selected);
  if (pointer.ledgerAuthority.databasePath !== options.path) {
    throw new Error("Retained recipe pointer selects another native store.");
  }
  assertManagedUpdateLeaseDatabaseIdentity(pointer.ledgerAuthority);
  return runExistingOpenClawStateWriteTransaction(
    ({ db }) => {
      assertCurrent("transaction");
      assertManagedUpdateLeaseDatabaseIdentity(pointer.ledgerAuthority);
      const run = readUpdateRunRecord(db, pointer.runId);
      if (!run || run.status !== "running" || run.createdAtMs !== pointer.originalCreatedAtMs) {
        throw new Error("Retained evidence requires its exact original running ledger owner.");
      }
      const current = readRetainedUpgradeRecipeRunInDatabase(db, pointer.runId);
      if (current) {
        if (!isDeepStrictEqual(current.pointer, pointer)) {
          throw new Error(
            "Original retained evidence is immutable; never adopt replacement evidence.",
          );
        }
      } else {
        executeSqliteQuerySync(
          db,
          getNodeSqliteKysely<PointerDatabase>(db)
            .insertInto("config_machine_state")
            .values({
              state_key: key(pointer.runId),
              value_json: JSON.stringify(pointer),
              updated_at_ms: Date.now(),
            }),
        );
      }
      assertCurrent("commit");
      assertManagedUpdateLeaseDatabaseIdentity(pointer.ledgerAuthority);
      return pointer;
    },
    options,
    { schemaSql, operationLabel: "upgrade.recipe-run" },
  );
}
