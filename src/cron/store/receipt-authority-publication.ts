import type { DatabaseSync } from "node:sqlite";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { deferSqlitePostCommitPublication } from "../../infra/sqlite-post-commit.js";
import { readSqliteWorkerOperationAdmissionAttachment } from "../../infra/sqlite-worker-operation-admission.js";
import type {
  CronReceiptAuthorityAttachment,
  CronReceiptAuthorityPublication,
} from "./receipt-authority.types.js";
import { readCronRunReceiptCurrentFactsInDatabase } from "./run-receipt-read.js";

const sequences = new WeakMap<CronReceiptAuthorityAttachment, number>();

export function readCronReceiptAuthorityAttachment(): CronReceiptAuthorityAttachment | undefined {
  const value = readSqliteWorkerOperationAdmissionAttachment();
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value) || typeof value.nonce !== "string" || !Array.isArray(value.reads)) {
    throw new Error("Cron receipt authority attachment is invalid");
  }
  // SAFETY: This private attachment is supplied by the host owner before worker dispatch.
  return value as CronReceiptAuthorityAttachment;
}

export function prepareCronReceiptAuthorityPublication(
  db: DatabaseSync,
  attachment: CronReceiptAuthorityAttachment,
): CronReceiptAuthorityPublication;
export function prepareCronReceiptAuthorityPublication(
  db: DatabaseSync,
): CronReceiptAuthorityPublication | undefined;
export function prepareCronReceiptAuthorityPublication(
  db: DatabaseSync,
  attachment = readCronReceiptAuthorityAttachment(),
): CronReceiptAuthorityPublication | undefined {
  if (!attachment) {
    return undefined;
  }
  const sequence = (sequences.get(attachment) ?? 0) + 1;
  const receipts = attachment.reads.map((command) =>
    readCronRunReceiptCurrentFactsInDatabase(db, command),
  );
  if (!deferSqlitePostCommitPublication(db, () => sequences.set(attachment, sequence))) {
    throw new Error("Cron receipt publication requires its transaction owner");
  }
  return { nonce: attachment.nonce, sequence, receipts };
}
