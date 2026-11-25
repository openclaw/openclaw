import type { AgentWorkerOperationContext } from "./openclaw-agent-operation-context.js";
import type { WorkerOperationHandlers } from "./worker-operation-registry.js";

type Handlers = WorkerOperationHandlers<AgentWorkerOperationContext>;

export async function loadUsageCacheOperations() {
  const [
    {
      pruneSessionCostUsageRollupsInDatabase,
      retireLegacySessionCostUsageCacheInDatabase,
      writeSessionCostUsageRollupsInDatabase,
    },
    { withSqliteDatabaseWriteScope },
    { writeSessionCostUsageQuartersInDatabase },
  ] = await Promise.all([
    import("../infra/session-cost-usage-cache.kernel.js"),
    import("../infra/sqlite-database-admission.js"),
    import("../infra/session-cost-usage-quarters.worker.js"),
  ]);
  // Usage cache and partition writes do not change resident session facts.
  return {
    "usageCache.retireLegacy": (_input: undefined, { writeTransaction, admit }) =>
      writeTransaction("session-cost-usage.legacy.retire", "Usage cache", ({ db }) => {
        retireLegacySessionCostUsageCacheInDatabase(db);
        admit("commit");
      }),
    "usageCache.writeRollup": (
      input: Parameters<typeof writeSessionCostUsageRollupsInDatabase>[1],
      { writeTransaction, admit },
    ) =>
      writeTransaction("session-cost-usage.rollup.write", "Usage cache", ({ db }) => {
        writeSessionCostUsageRollupsInDatabase(db, input);
        admit("commit");
        return true;
      }),
    "usageCache.writeQuarters": (
      input: Parameters<typeof writeSessionCostUsageQuartersInDatabase>[1],
      { writeTransaction, admit },
    ) =>
      writeTransaction("session-cost-usage.quarters.write", "Usage cache", ({ db }) => {
        writeSessionCostUsageQuartersInDatabase(db, input);
        admit("commit");
        return true;
      }),
    "usageCache.prune": (
      input: Parameters<typeof pruneSessionCostUsageRollupsInDatabase>[1],
      { writeTransaction, admit },
    ) =>
      writeTransaction("session-cost-usage.rollup.prune", "Usage cache", ({ db }) => {
        withSqliteDatabaseWriteScope(db, [], () =>
          pruneSessionCostUsageRollupsInDatabase(db, input),
        );
        admit("commit");
      }),
  } satisfies Handlers;
}
