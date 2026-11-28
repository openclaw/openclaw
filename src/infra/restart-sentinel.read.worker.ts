import type { WorkerOperationHandlers } from "../state/worker-operation-registry.js";
import {
  inspectManagedHandoffSentinelRowSync,
  readRestartSentinelRowSync,
  readRestartSentinelSnapshotSync,
  readUpdateInstallReceiptRowSync,
  type ManagedHandoffSentinelIdentity,
} from "./restart-sentinel-store.js";
import type { EngineConnection } from "./sql-connection.js";
import { runSqliteReadSnapshotSync } from "./sqlite-transaction.js";

export const restartSentinelReadOperations = {
  "restartSentinel.managedHandoffInspect": (input: ManagedHandoffSentinelIdentity, db) =>
    runSqliteReadSnapshotSync(db, () => ({
      type: "restartSentinel.managedHandoffInspect" as const,
      snapshot: inspectManagedHandoffSentinelRowSync(db, input),
    })),
  "restartSentinel.current": (_input: undefined, db) => ({
    type: "restartSentinel.current" as const,
    state: readRestartSentinelRowSync(db),
  }),
  "restartSentinel.snapshot": (_input: undefined, db) => {
    const { state, revision } = readRestartSentinelSnapshotSync(db);
    return {
      type: "restartSentinel.snapshot" as const,
      snapshot: { sentinel: state.kind === "valid" ? state.sentinel : null, revision },
    };
  },
  "restartSentinel.installReceipt": (_input: undefined, db) => ({
    type: "restartSentinel.installReceipt" as const,
    sentinel: readUpdateInstallReceiptRowSync(db),
  }),
} satisfies WorkerOperationHandlers<EngineConnection>;
