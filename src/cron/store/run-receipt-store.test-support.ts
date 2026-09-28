import { runOpenClawStateWriteTransaction } from "../../state/openclaw-state-db.js";
import type { CronJob } from "../types.js";
import {
  claimCronRunReceiptInDatabase,
  findActiveCronRunReceiptInDatabase,
  prepareCronRunReceiptClaim,
} from "./run-receipt-store.js";
import { prepareCronRunReceiptWriteSchema } from "./run-receipt-write-admission.js";

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
    storePath,
    job,
    agentId: job.agentId!,
    startedAtMs,
  });
  return runOpenClawStateWriteTransaction(({ db }) =>
    claimCronRunReceiptInDatabase({
      database: db,
      receiptSchema: prepareCronRunReceiptWriteSchema(db),
      prepared,
      resolveAgentId: (current) => current.agentId!,
    }),
  );
}
