import type { DatabaseSync } from "node:sqlite";
import { resolveCronJobsStorePathInDatabase } from "../cron/store/paths.js";
import { runSqliteDeferredTransactionSync } from "../infra/sqlite-transaction.js";
import { getSqliteWorkerStateContext } from "../infra/sqlite-worker-state-context.js";
import { readClawMonitorCleanupSnapshotInDatabase } from "./monitor-cleanup-read.kernel.js";
import type { ClawMonitorCleanupReadOperations } from "./monitor-cleanup.read.types.js";
import { readPortableHeartbeatStateInDatabase } from "./portable-heartbeat-state.kernel.js";

export const clawMonitorCleanupReadOperations = {
  "clawMonitorCleanup.snapshot": (
    input: ClawMonitorCleanupReadOperations["clawMonitorCleanup.snapshot"]["input"],
    db,
  ) =>
    runSqliteDeferredTransactionSync(db, () => ({
      type: "clawMonitorCleanup.snapshot" as const,
      snapshot: readClawMonitorCleanupSnapshotInDatabase(db, input),
    })),
  "clawMonitorCleanup.portable": (input: { agentId: string; storePath: string | undefined }, db) =>
    runSqliteDeferredTransactionSync(db, () => ({
      type: "clawMonitorCleanup.portable" as const,
      state: readPortableHeartbeatStateInDatabase(
        db,
        input.agentId,
        resolveCronJobsStorePathInDatabase(
          db,
          input.storePath,
          getSqliteWorkerStateContext().environment,
        ),
      ),
    })),
} satisfies {
  [Key in keyof ClawMonitorCleanupReadOperations]: (
    input: ClawMonitorCleanupReadOperations[Key]["input"],
    db: DatabaseSync,
  ) => ClawMonitorCleanupReadOperations[Key]["output"];
};
