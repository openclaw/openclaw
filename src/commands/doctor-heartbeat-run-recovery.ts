import { resolveDefaultAgentId } from "../agents/agent-scope-config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { DeferredCronNotifications } from "../cron/service/state.js";
import { receiptFromRow, type CronRunReceiptDatabase } from "../cron/store/run-receipt-read.js";
import { prepareCronRunReceiptWriteSchema } from "../cron/store/run-receipt-write-admission.js";
import { recoverCronJobInDatabase } from "../cron/store/run-recovery.kernel.js";
import type { CronRunRecoveryOutcome } from "../cron/store/run-recovery.types.js";
import { createCronMutationLogger } from "../cron/store/runtime-mutation.worker.js";
import { captureGatewayStateOwner } from "../infra/gateway-state-owner.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import { DoctorMaintenanceRefusalError } from "../infra/update-doctor-result.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { getOpenClawDatabaseMaintenanceScope } from "../state/openclaw-state-db-async-lifecycle.js";
import type { OpenClawStateDatabase } from "../state/openclaw-state-db-contract.js";
import type { DoctorCronJob } from "./doctor-heartbeat-jobs.js";

export class DoctorHeartbeatMigrationDeferredError extends DoctorMaintenanceRefusalError {
  constructor(message: string) {
    super(message, { kind: "deferred", reason: "admission-unavailable" });
    this.name = "DoctorHeartbeatMigrationDeferredError";
  }
}

/** Doctor adapts the retired payload; cron's startup owner alone settles the run. */
export function recoverDoctorHeartbeatRun(params: {
  database: OpenClawStateDatabase;
  storeKey: string;
  job: DoctorCronJob;
  cfg: OpenClawConfig;
  nowMs: number;
}): DoctorCronJob | undefined {
  const { database, storeKey, job, cfg, nowMs } = params;
  const maintenance = getOpenClawDatabaseMaintenanceScope();
  const owner = captureGatewayStateOwner(database.path);
  if (!maintenance?.ownsSchemaMaintenance || owner?.role !== "sqlite-maintenance") {
    throw new DoctorHeartbeatMigrationDeferredError(
      `Heartbeat migration deferred: automation ${job.id} is running or its runtime owner is unproved. Its job and configuration were retained; stop the Gateway and rerun openclaw doctor --fix.`,
    );
  }
  maintenance.assertAdmission();
  owner.assertCurrent();
  // Maintenance admission has verified legacy Gateway shutdown and excluded a
  // current Gateway writer. A persisted marker now belongs to startup recovery.
  const recovered = {
    ...job,
    payload:
      job.payload.kind === "heartbeat"
        ? { ...job.payload, kind: "systemEvent" as const, text: "" }
        : job.payload,
  };
  const receiptRow = executeSqliteQuerySync(
    database.db,
    getNodeSqliteKysely<CronRunReceiptDatabase>(database.db)
      .selectFrom("cron_run_receipts")
      .selectAll()
      .where("store_key", "=", storeKey)
      .where("job_id", "=", job.id)
      .where("status", "=", "running"),
  ).rows[0];
  const notifications: DeferredCronNotifications = [];
  const logs: CronRunRecoveryOutcome["logs"] = [];
  const result = recoverCronJobInDatabase({
    database,
    storeKey,
    job: recovered,
    receipt: receiptRow ? receiptFromRow(receiptRow) : undefined,
    receiptSchema: prepareCronRunReceiptWriteSchema(database.db),
    state: {
      deps: {
        nowMs: () => nowMs,
        cronConfig: cfg.cron,
        defaultAgentId: resolveDefaultAgentId(cfg),
        log: createCronMutationLogger(logs),
      },
    },
    notifications,
  });
  if (notifications.length) {
    // Offline Doctor cannot deliver startup notifications. Roll back settlement
    // with the conversion so Gateway startup can recover and dispatch them.
    throw new DoctorHeartbeatMigrationDeferredError(
      `Heartbeat migration deferred: automation ${job.id} needs Gateway startup recovery notifications. Its job and configuration were retained; restart the Gateway, then rerun openclaw doctor --fix.`,
    );
  }
  const log = createSubsystemLogger("cron");
  for (const entry of logs) {
    log[entry.level](entry.message ?? "cron: heartbeat run recovery", { fields: entry.fields });
  }
  if (result.removed) {
    return undefined;
  }
  return job.payload.kind === "heartbeat" ? { ...recovered, payload: job.payload } : recovered;
}
