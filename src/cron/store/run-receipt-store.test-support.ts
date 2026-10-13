import crypto from "node:crypto";
import { getFileLockProcessStartTime } from "../../shared/pid-alive.js";
import { runOpenClawStateWriteTransaction } from "../../state/openclaw-state-db.js";
import { resolveCronJobConfigRevision } from "../config-revision.js";
import type { CronJob } from "../types.js";
import { cronStoreKey } from "./key.js";
import { loadedCronStoreFromRows, loadCronRows } from "./row-codec.js";
import {
  claimCronRunReceiptInDatabase,
  finishCronRunReceiptInDatabase,
  findActiveCronRunReceiptInDatabase,
} from "./run-receipt-store.js";
import { prepareCronRunReceiptWriteSchema } from "./run-receipt-write-admission.js";
import type { CronRunReceiptHandle, CronRunReceiptOwnerObservation } from "./run-receipt.types.js";

export function inspectActiveCronRunReceipt(params: { storePath: string; jobId: string }) {
  return runOpenClawStateWriteTransaction(({ db }) =>
    findActiveCronRunReceiptInDatabase({ database: db, ...params }),
  );
}

export function makeCronRecoveryJob(id: string, startedAtMs: number): CronJob {
  return {
    id,
    agentId: "alpha",
    name: id,
    enabled: true,
    createdAtMs: startedAtMs - 1,
    updatedAtMs: startedAtMs - 1,
    schedule: { kind: "every", everyMs: 60_000, anchorMs: startedAtMs },
    sessionTarget: "isolated",
    wakeMode: "next-heartbeat",
    payload: { kind: "command", argv: ["true"] },
    state: { runningAtMs: startedAtMs, nextRunAtMs: startedAtMs },
  };
}

export function makeCronReceiptJob(id: string, agentId = "alpha"): CronJob {
  return {
    id,
    agentId,
    name: id,
    enabled: true,
    createdAtMs: 1,
    updatedAtMs: 1,
    schedule: { kind: "every", everyMs: 60_000 },
    sessionTarget: "isolated",
    wakeMode: "next-heartbeat",
    payload: { kind: "agentTurn", message: id },
    state: {},
  };
}

export function claimCronRunReceiptForTest(storePath: string, job: CronJob, startedAtMs: number) {
  const prepared = prepareCronRunReceiptClaim({
    observed: inspectActiveCronRunReceipt({ storePath, jobId: job.id }),
    storePath,
    job,
    agentId: job.agentId!,
    startedAtMs,
  });
  return runOpenClawStateWriteTransaction(({ db }) =>
    claimCronRunReceiptInDatabaseForTest({
      database: db,
      prepared,
      resolveAgentId: (current) => current.agentId!,
    }),
  );
}

export function claimCronRunReceiptInDatabaseForTest(params: {
  database: Parameters<typeof claimCronRunReceiptInDatabase>[0]["database"];
  prepared: ReturnType<typeof prepareCronRunReceiptClaim>;
  resolveAgentId: (job: CronJob) => string;
}) {
  const { handle: preparedHandle } = params.prepared;
  const handle = claimCronRunReceiptInDatabase({
    database: params.database,
    handle: preparedHandle,
    job: loadedCronStoreFromRows(
      loadCronRows(params.database, preparedHandle.storeKey, new Set([preparedHandle.jobId])),
    ).store.jobs[0],
    requestRunId: params.prepared.requestRunId,
    resolveAgentId: params.resolveAgentId,
    receiptSchema: prepareCronRunReceiptWriteSchema(params.database),
  });
  return handle;
}

export async function finishCronRunReceiptAsync(
  params: Omit<Parameters<typeof finishCronRunReceiptInDatabase>[0], "database" | "receiptSchema">,
): Promise<void> {
  runOpenClawStateWriteTransaction(({ db }) =>
    finishCronRunReceiptInDatabase({
      database: db,
      receiptSchema: prepareCronRunReceiptWriteSchema(db),
      ...params,
    }),
  );
}

export function prepareCronRunReceiptClaim(params: {
  storePath: string;
  job: CronJob;
  agentId: string;
  startedAtMs: number;
  requestRunId?: string;
  observed: CronRunReceiptOwnerObservation | undefined;
}) {
  const ownerStartTime = getFileLockProcessStartTime(process.pid);
  const storeKey = cronStoreKey(params.storePath);
  const handle: CronRunReceiptHandle = {
    receiptId: crypto.randomUUID(),
    storeKey,
    jobId: params.job.id,
    configRevision: resolveCronJobConfigRevision(params.job),
    agentId: params.agentId,
    ownerPid: process.pid,
    ownerStartTime,
    startedAtMs: params.startedAtMs,
  };
  return {
    handle,
    ...(params.requestRunId ? { requestRunId: params.requestRunId } : {}),
  };
}
