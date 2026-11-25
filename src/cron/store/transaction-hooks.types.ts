import type { EngineConnection } from "../../infra/sql-connection.js";
import type { CronRunReceiptWriteSchema } from "./run-receipt-write-admission.js";

export type CronStoreTransactionHooks = {
  // void accepts Promise-returning functions; every hook must finish before its caller proceeds.
  beforeWrite?: (db: EngineConnection, receiptSchema: CronRunReceiptWriteSchema) => undefined;
  afterWrite?: (db: EngineConnection, receiptSchema: CronRunReceiptWriteSchema) => undefined;
  afterCommit?: () => undefined;
};

export type CronAdmittedStoreTransactionHooks = {
  hooks: CronStoreTransactionHooks;
  receiptSchema: CronRunReceiptWriteSchema;
};
