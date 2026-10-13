import { once } from "node:events";
import path from "node:path";
import { parentPort, workerData } from "node:worker_threads";

const { register } = await import(workerData.sourceLoaderUrl);
register();
const { runWithSqliteMutationWorkerCoordination } =
  await import("./session-accessor.sqlite-worker-coordination.ts");
const { acquireGatewayStateOwner } = await import("../../infra/gateway-state-owner.ts");
const { claimOpenClawAgentDatabaseLease, releaseOpenClawAgentDatabaseLease } =
  await import("../../state/openclaw-agent-db-lease.ts");
const { closeOpenClawStateDatabase } = await import("../../state/openclaw-state-db.ts");
const [coordination] = await once(parentPort, "message");
const execute = () =>
  runWithSqliteMutationWorkerCoordination(
    coordination,
    { agentId: workerData.operation, path: workerData.agentPath },
    async (options) => {
      if (workerData.operation === "hold") {
        const stateDir = coordination.stateContext.environment.OPENCLAW_STATE_DIR;
        const owner = acquireGatewayStateOwner({
          databasePath: coordination.databasePath,
          payload: {
            pid: process.pid,
            createdAt: new Date().toISOString(),
            configPath: path.join(stateDir, "openclaw.json"),
            stateDir,
            role: "gateway",
          },
        });
        try {
          parentPort.postMessage("held", []);
          const release = new Int32Array(workerData.release);
          Atomics.wait(release, 0, 0);
        } finally {
          owner.release();
        }
      } else if (workerData.operation === "cold-quarantine") {
        const { openOpenClawStateDatabase, runOpenClawStateWriteTransaction } =
          await import("../../state/openclaw-state-db.ts");
        const { readOpenClawDatabaseQuarantineFailure } =
          await import("../../state/openclaw-quarantine-store.ts");
        const database = openOpenClawStateDatabase({ env: options.env });
        runOpenClawStateWriteTransaction(
          () => {
            parentPort.postMessage("held", []);
            Atomics.wait(new Int32Array(workerData.release), 0, 0);
            const failure = readOpenClawDatabaseQuarantineFailure("agent", workerData.agentPath, {
              env: options.env,
            });
            if (failure) {
              throw failure;
            }
          },
          { database, env: options.env },
        );
        closeOpenClawStateDatabase();
        parentPort.postMessage("checked", []);
      } else {
        const lease = claimOpenClawAgentDatabaseLease(options);
        releaseOpenClawAgentDatabaseLease(lease, { env: options.env });
        closeOpenClawStateDatabase();
        parentPort.postMessage("claimed", []);
      }
    },
  );
if (coordination.fallbackAdmission) {
  const { withSqliteDatabaseAdmissionExchange } =
    await import("../../infra/sqlite-database-admission.ts");
  const { exchangeSqliteDatabaseAdmissions } =
    await import("../../infra/sqlite-worker-database-admission-relay.ts");
  await withSqliteDatabaseAdmissionExchange(
    (...args) => exchangeSqliteDatabaseAdmissions(coordination.fallbackAdmission, ...args),
    execute,
  );
  coordination.fallbackAdmission.close();
} else {
  await execute();
}
parentPort.close();
