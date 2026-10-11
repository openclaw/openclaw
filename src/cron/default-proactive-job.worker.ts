import { getSqliteWorkerStateContext } from "../infra/sqlite-worker-state-context.js";
import { assertAgentDeletionRecoveryHoldPredicate } from "../state/agent-deletion-journal-recovery.kernel.js";
import {
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import {
  readDefaultProactiveJobReceiptInDatabase,
  recordDefaultProactiveJobInDatabase,
} from "./proactive-job-receipt.kernel.js";
import { cronStoreKey } from "./store/key.js";
import { resolveCronJobsStorePathInDatabase } from "./store/paths.js";
import { loadCronRows, loadedCronStoreFromRows, upsertCronJobRow } from "./store/row-codec.js";
import type {
  CronRuntimeMutationContracts,
  CronRuntimeWorkerOperations,
} from "./store/runtime-worker.types.js";

export function provisionDefaultProactiveJobInWorker(
  database: OpenClawStateDatabase,
  input: CronRuntimeWorkerOperations["cron.provisionDefaultProactive"]["input"],
): CronRuntimeWorkerOperations["cron.provisionDefaultProactive"]["output"] {
  const env = getSqliteWorkerStateContext().environment;
  return runOpenClawStateWriteTransaction(
    (writer) => {
      const { db } = writer;
      const storePath = resolveCronJobsStorePathInDatabase(db, input.storePath, env);
      const storeKey = cronStoreKey(storePath);
      const rows = loadCronRows(db, storeKey);
      const receipt = readDefaultProactiveJobReceiptInDatabase(db, storePath, input.agentId);
      assertAgentDeletionRecoveryHoldPredicate(writer, input.recoveryHoldPredicate);
      let outcome: CronRuntimeMutationContracts["cron.provisionDefaultProactive"]["outcome"];
      if (receipt) {
        if (receipt.phase !== "complete") {
          throw new Error(
            "Proactive migration is incomplete; run openclaw doctor --fix before provisioning.",
          );
        }
        outcome = {
          storeKey,
          created: false,
          job: loadedCronStoreFromRows(rows).store.jobs.find((job) => job.id === receipt.jobId),
        };
      } else {
        if (
          rows.some((row) => row.payload_kind === "heartbeat" && row.agent_id === input.agentId)
        ) {
          throw new Error(
            "Legacy proactive state needs openclaw doctor --fix before agent provisioning.",
          );
        }
        const nextOrder = rows.reduce((maximum, row) => Math.max(maximum, row.sort_order), -1) + 1;
        const job = upsertCronJobRow(db, storeKey, input.planned, nextOrder);
        recordDefaultProactiveJobInDatabase(db, storePath, input.agentId, job.id, job.createdAtMs);
        outcome = { storeKey, created: true, job };
      }
      assertAgentDeletionRecoveryHoldPredicate(writer, input.recoveryHoldPredicate);
      return { outcome };
    },
    { database, path: database.path, env },
    { operationLabel: "cron.provision-default-proactive" },
  );
}
