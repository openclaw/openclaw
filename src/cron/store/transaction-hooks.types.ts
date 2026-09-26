import type { DatabaseSync } from "node:sqlite";
import type { CronRunReceiptWriteSchema } from "./run-receipt-write-admission.js";

export type CronStoreTransactionHooks = {
  // void accepts Promise-returning functions; every hook must finish before its caller proceeds.
  beforeWrite?: (db: DatabaseSync, receiptSchema: CronRunReceiptWriteSchema) => undefined;
  afterWrite?: (db: DatabaseSync, receiptSchema: CronRunReceiptWriteSchema) => undefined;
  afterCommit?: () => undefined;
};

export type CronAdmittedStoreTransactionHooks = {
  hooks: CronStoreTransactionHooks;
  receiptSchema: CronRunReceiptWriteSchema;
};
