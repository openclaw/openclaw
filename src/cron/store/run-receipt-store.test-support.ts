import { runOpenClawStateWriteTransaction } from "../../state/openclaw-state-db.js";
import type { CronJob } from "../types.js";
import { findActiveCronRunReceiptInDatabase } from "./run-receipt-store.js";

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
