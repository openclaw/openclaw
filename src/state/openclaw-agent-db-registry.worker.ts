import { assertDatabasePathIdentity } from "../infra/sqlite-worker-identity.js";
import {
  deferSqliteWorkerCommitReceipt,
  requestSqliteWorkerOperationAdmission,
} from "../infra/sqlite-worker-operation-admission.js";
import type { AgentDatabaseRegistryWorkerOperations } from "./openclaw-agent-db-contract.js";
import { unregisterOpenClawAgentDatabase } from "./openclaw-agent-db-registry.js";
import { requireOpenClawStateDatabaseIdentity } from "./openclaw-state-db-cache.js";
import { runOpenClawStateWriteTransaction } from "./openclaw-state-db.js";
import type { WorkerOperationHandlers } from "./worker-operation-registry.js";

export const agentDatabaseRegistryOperations = {
  "agentDatabaseRegistry.remove": (
    input: AgentDatabaseRegistryWorkerOperations["agentDatabaseRegistry.remove"]["input"],
    { stateOptions },
  ) => {
    const options = stateOptions();
    return runOpenClawStateWriteTransaction((database) => {
      requestSqliteWorkerOperationAdmission({ stage: "transaction", facts: undefined });
      assertDatabasePathIdentity(input.agentPath, input.identity);
      unregisterOpenClawAgentDatabase({
        agentId: input.agentId,
        path: input.agentPath,
        env: options.env,
      });
      requestSqliteWorkerOperationAdmission({ stage: "commit", facts: undefined });
      const receipt = {
        agentId: input.agentId,
        agentPath: input.agentPath,
        stateDatabasePath: database.path,
        stateDatabaseIdentity: requireOpenClawStateDatabaseIdentity(database).key,
      };
      deferSqliteWorkerCommitReceipt(database.db, receipt);
      return receipt;
    }, options);
  },
} satisfies WorkerOperationHandlers;
