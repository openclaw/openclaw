import { isDeepStrictEqual } from "node:util";
import { safeParseJsonRecord } from "@openclaw/normalization-core/json-coercion";
import { migrateCronMemberSourceRoleStandingGrantReferences } from "../../gateway/operator-approval-standing-grants.worker.js";
import { operatorStandingGrantPublication } from "../../gateway/operator-approval-store.publication.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import type { EngineConnection } from "../../infra/sql-connection.js";
import {
  deferSqliteWorkerCommitReceipt,
  requestSqliteWorkerOperationAdmission,
} from "../../infra/sqlite-worker-operation-admission.js";
import { getSqliteWorkerStateContext } from "../../infra/sqlite-worker-state-context.js";
import { tableExists } from "../../state/openclaw-state-db-schema-helpers.js";
import type { DB } from "../../state/openclaw-state-db.generated.js";
import {
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { resolveCronJobConfigRevision } from "../config-revision.js";
import { resolveCronJobGrantDefinitionRevision } from "./job-config-codec.js";
import { importLegacyCronMemberSources } from "./member-source-role-import.js";
import { rowToCronJob } from "./row-codec.js";
import type { CronRuntimeWorkerOperations } from "./runtime-worker.types.js";

export function importLegacyCronMemberSourcesInWorker(
  database: OpenClawStateDatabase,
  input: CronRuntimeWorkerOperations["cron.importLegacyMemberSources"]["input"],
): CronRuntimeWorkerOperations["cron.importLegacyMemberSources"]["output"] {
  requestSqliteWorkerOperationAdmission({ stage: "transaction", facts: undefined });
  return runOpenClawStateWriteTransaction(
    ({ db }) => {
      const captured = operatorStandingGrantPublication.capture(db, () => importSources(db, input));
      const receipt = {
        standingGrantFacts: operatorStandingGrantPublication.bound(captured.receipt),
      };
      deferSqliteWorkerCommitReceipt(db, receipt);
      requestSqliteWorkerOperationAdmission({ stage: "commit", facts: undefined });
      return { outcome: { storeKeys: captured.result } };
    },
    { database, env: getSqliteWorkerStateContext().environment },
    { operationLabel: "cron.importLegacyMemberSources" },
  );
}

function importSources(
  db: EngineConnection,
  input: CronRuntimeWorkerOperations["cron.importLegacyMemberSources"]["input"],
): string[] {
  const stateDb = getNodeSqliteKysely<Pick<DB, "cron_jobs" | "cron_run_receipts">>(db);
  const rows = executeSqliteQuerySync(db, stateDb.selectFrom("cron_jobs").selectAll()).rows;
  const counts = new Map<string, number>();
  for (const row of rows) {
    counts.set(row.job_id, (counts.get(row.job_id) ?? 0) + 1);
  }
  const hasReceipts = tableExists(db, "cron_run_receipts");
  const storeKeys = new Set<string>();
  for (const row of rows) {
    const definition = safeParseJsonRecord(row.job_json);
    if (!definition) {
      continue;
    }
    let previous;
    try {
      previous = rowToCronJob(row, definition);
    } catch {
      // Invalid stored definitions retain their existing quarantine/recovery path.
      continue;
    }
    if (
      !previous ||
      !isDeepStrictEqual(definition.streamOperatorSource, previous.streamOperatorSource) ||
      !isDeepStrictEqual(definition.streamSandbox, previous.streamSandbox)
    ) {
      continue;
    }
    const next = importLegacyCronMemberSources(previous, input);
    if (next === previous) {
      continue;
    }
    const previousRevision = resolveCronJobConfigRevision(previous);
    const nextRevision = resolveCronJobConfigRevision(next);
    const validProjection =
      row.grant_definition_revision === resolveCronJobGrantDefinitionRevision(previous) &&
      row.grant_definition_updated_at === row.updated_at;
    if (
      validProjection &&
      typeof row.grant_definition_generation === "number" &&
      Number.isSafeInteger(row.grant_definition_generation) &&
      row.grant_definition_generation >= 1 &&
      counts.get(row.job_id) === 1
    ) {
      migrateCronMemberSourceRoleStandingGrantReferences(
        db,
        previous,
        next,
        row.grant_definition_generation,
        input,
      );
    }
    executeSqliteQuerySync(
      db,
      stateDb
        .updateTable("cron_jobs")
        .set({
          job_json: JSON.stringify({
            ...definition,
            ...(next.operatorSource !== previous.operatorSource
              ? { operatorSource: next.operatorSource }
              : {}),
            ...(next.streamOperatorSource !== previous.streamOperatorSource
              ? { streamOperatorSource: next.streamOperatorSource }
              : {}),
            ...(next.streamSandbox !== previous.streamSandbox
              ? { streamSandbox: next.streamSandbox }
              : {}),
          }),
          ...(validProjection
            ? { grant_definition_revision: resolveCronJobGrantDefinitionRevision(next) }
            : {}),
        })
        .where("store_key", "=", row.store_key)
        .where("job_id", "=", row.job_id),
    );
    if (hasReceipts) {
      executeSqliteQuerySync(
        db,
        stateDb
          .updateTable("cron_run_receipts")
          .set({ config_revision: nextRevision })
          .where("store_key", "=", row.store_key)
          .where("job_id", "=", row.job_id)
          .where("config_revision", "=", previousRevision),
      );
    }
    storeKeys.add(row.store_key);
  }
  return [...storeKeys];
}
