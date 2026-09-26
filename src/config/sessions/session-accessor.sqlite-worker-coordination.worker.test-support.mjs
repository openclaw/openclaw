import { once } from "node:events";
import { parentPort, workerData } from "node:worker_threads";

const { register } = await import(workerData.sourceLoaderUrl);
register();
const { runWithSqliteMutationWorkerCoordination } =
  await import("./session-accessor.sqlite-worker-coordination.ts");
const { acquireStateDatabaseCoordinator } =
  await import("../../infra/state-database-coordinator.ts");
const { claimOpenClawAgentDatabaseLease, releaseOpenClawAgentDatabaseLease } =
  await import("../../state/openclaw-agent-db-lease.ts");
const { closeOpenClawStateDatabase } = await import("../../state/openclaw-state-db.ts");
const [coordination] = await once(parentPort, "message");
await runWithSqliteMutationWorkerCoordination(
  coordination,
  1,
  { agentId: workerData.operation, path: workerData.agentPath },
  async (options) => {
    if (workerData.operation === "hold") {
      const owner = acquireStateDatabaseCoordinator({ databasePath: coordination.databasePath });
      try {
        parentPort.postMessage("held", []);
        const release = new Int32Array(workerData.release);
        Atomics.wait(release, 0, 0);
      } finally {
        owner.release();
      }
    } else {
      const lease = claimOpenClawAgentDatabaseLease(options);
      releaseOpenClawAgentDatabaseLease(lease, { env: options.env });
      closeOpenClawStateDatabase();
      parentPort.postMessage("claimed", []);
    }
  },
);
parentPort.close();
