import type { DatabaseSync } from "node:sqlite";
import type { WorkerOperationHandlers } from "../state/worker-operation-registry.js";
import {
  readRestartSentinelRowSync,
  readRestartSentinelSnapshotSync,
  readUpdateInstallReceiptRowSync,
} from "./restart-sentinel-store.js";
import { runSqliteDeferredTransactionSync } from "./sqlite-transaction.js";
import { readUpdateFailureReportReceiptRowSync } from "./update-failure-report-receipt-store.js";

export const restartSentinelReadOperations = {
  "restartSentinel.reportReceipt": (input: string, db) => ({
    type: "restartSentinel.reportReceipt" as const,
    receipt: readUpdateFailureReportReceiptRowSync(db, input),
  }),
  "restartSentinel.current": (_input: undefined, db) => ({
    type: "restartSentinel.current" as const,
    state: readRestartSentinelRowSync(db),
  }),
  "restartSentinel.snapshot": (_input: undefined, db) =>
    runSqliteDeferredTransactionSync(db, () => {
      const { state, revision } = readRestartSentinelSnapshotSync(db);
      return {
        type: "restartSentinel.snapshot" as const,
        snapshot: { sentinel: state.kind === "valid" ? state.sentinel : null, revision },
      };
    }),
  "restartSentinel.installReceipt": (_input: undefined, db) => ({
    type: "restartSentinel.installReceipt" as const,
    sentinel: readUpdateInstallReceiptRowSync(db),
  }),
} satisfies WorkerOperationHandlers<DatabaseSync>;
