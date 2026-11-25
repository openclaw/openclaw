import { createAgentDatabaseMaintenanceOwner } from "./openclaw-agent-execution-maintenance.js";
import { createAgentWorkerOperationLoaders } from "./openclaw-agent-execution-operations.js";
import type { AgentWorkerOperationContext } from "./openclaw-agent-operation-context.js";

export function createAgentWorkerTestLoaders(
  context: Pick<AgentWorkerOperationContext, "options" | "open" | "admit">,
) {
  const maintenance = createAgentDatabaseMaintenanceOwner({
    databaseOptions: { ...context.options, env: context.options.env ?? process.env },
    openWriter: context.open,
    admit: context.admit,
  });
  return createAgentWorkerOperationLoaders(maintenance.operations);
}
