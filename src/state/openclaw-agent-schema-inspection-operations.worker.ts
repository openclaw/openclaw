import { readExistingAgentSchemaMeta } from "./openclaw-agent-db-metadata.js";
import { readAgentDatabaseSchemaVersion } from "./openclaw-agent-db-schema-read.js";
import type { AgentWorkerOperationContext } from "./openclaw-agent-operation-context.js";
import type { WorkerOperationHandlers } from "./worker-operation-registry.js";

export async function loadAgentSchemaInspectionOperations() {
  return {
    "database.schema.inspect": (_input: undefined, { open }) => {
      const database = open();
      return {
        version: readAgentDatabaseSchemaVersion(database.db),
        integrityGateOutcome: "healthy" as const,
        agentSchemaMeta: readExistingAgentSchemaMeta(database.db),
      };
    },
  } satisfies WorkerOperationHandlers<AgentWorkerOperationContext>;
}
