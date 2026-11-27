import crypto from "node:crypto";
import { getFileLockProcessStartTime } from "../../shared/pid-alive.js";
import { runOpenClawStateWriteTransaction as write } from "../../state/openclaw-state-db.js";
import { resolveCronJobConfigRevision } from "../config-revision.js";
import { makeCronJob } from "../delivery.test-helpers.js";
import type { CronJob } from "../types.js";
import { cronStoreKey } from "./key.js";
import { loadedCronStoreFromRows, loadCronRows } from "./row-codec.js";
import {
  claimCronRunReceiptInDatabase as claimReceipt,
  finishCronRunReceiptInDatabase as finishReceipt,
  findActiveCronRunReceiptInDatabase as findActive,
} from "./run-receipt-store.js";
import { prepareCronRunReceiptWriteSchema } from "./run-receipt-write-admission.js";

export function inspectActiveCronRunReceipt(params: { storePath: string; jobId: string }) {
  return write(({ db }) => findActive({ database: db, ...params }));
}

export function makeCronRecoveryJob(id: string, startedAtMs: number): CronJob {
  return {
    ...makeCronReceiptJob(id),
    createdAtMs: startedAtMs - 1,
    updatedAtMs: startedAtMs - 1,
    schedule: { kind: "every", everyMs: 60_000, anchorMs: startedAtMs },
    payload: { kind: "command", argv: ["true"] },
    state: { runningAtMs: startedAtMs, nextRunAtMs: startedAtMs },
  };
}

export function makeCronReceiptJob(id: string, agentId = "alpha"): CronJob {
  const job = makeCronJob({ id, agentId, name: id, createdAtMs: 1, updatedAtMs: 1 });
  job.payload = { kind: "agentTurn", message: id };
  return job;
}

export function claimCronRunReceiptForTest(storePath: string, job: CronJob, startedAtMs: number) {
  const agentId = job.agentId!;
  const prepared = prepareCronRunReceiptClaim({ storePath, job, agentId, startedAtMs });
  return write(({ db }) => claimCronRunReceiptInDatabaseForTest({ database: db, prepared }));
}

export function claimCronRunReceiptInDatabaseForTest(params: {
  database: Parameters<typeof claimReceipt>[0]["database"];
  prepared: ReturnType<typeof prepareCronRunReceiptClaim>;
}) {
  const handle = claimReceipt({ database: params.database, ...params.prepared });
  if (!handle) {
    throw new Error("Fixture cron receipt is already claimed");
  }
  return handle;
}

type FinishParams = Omit<
  Parameters<typeof finishReceipt>[0],
  "database" | "receiptSchema" | "pendingReceiptId"
>;
export async function finishCronRunReceiptAsync(params: FinishParams): Promise<void> {
  write(({ db }) => {
    const job = loadedCronStoreFromRows(
      loadCronRows(db, params.handle.storeKey, new Set([params.handle.jobId])),
    ).store.jobs[0];
    finishReceipt({
      database: db,
      receiptSchema: prepareCronRunReceiptWriteSchema(db),
      pendingReceiptId:
        job?.state.runningAtMs === undefined ? undefined : job.state.runningReceiptId,
      ...params,
    });
  });
}

export function prepareCronRunReceiptClaim(params: {
  storePath: string;
  job: CronJob;
  agentId: string;
  startedAtMs: number;
  requestRunId?: string;
}) {
  const handle = {
    receiptId: crypto.randomUUID(),
    storeKey: cronStoreKey(params.storePath),
    jobId: params.job.id,
    configRevision: resolveCronJobConfigRevision(params.job),
    agentId: params.agentId,
    ownerPid: process.pid,
    ownerStartTime: getFileLockProcessStartTime(process.pid),
    startedAtMs: params.startedAtMs,
  };
  return {
    handle,
    ...(params.requestRunId ? { requestRunId: params.requestRunId } : {}),
  };
}
