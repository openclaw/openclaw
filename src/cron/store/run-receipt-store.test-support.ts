import { runOpenClawStateWriteTransaction } from "../../state/openclaw-state-db.js";
import { findActiveCronRunReceiptInDatabase } from "./run-receipt-store.js";

export function inspectActiveCronRunReceipt(params: { storePath: string; jobId: string }) {
  return runOpenClawStateWriteTransaction(({ db }) =>
    findActiveCronRunReceiptInDatabase({ database: db, ...params }),
  );
}
