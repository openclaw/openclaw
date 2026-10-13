import { hasDeletedAgentDatabases } from "../infra/agent-database-readers.js";
import { formatErrorMessage } from "../infra/errors.js";

/** A roster that admits an agent again may adopt databases its deletion left behind. */
export async function reviveAgentDatabasesAfterConfigCommit(
  agentIds: readonly string[],
  warn: (message: string) => void,
): Promise<void> {
  if (!hasDeletedAgentDatabases()) {
    return;
  }
  try {
    const { reviveAgentDatabases } = await import("../state/openclaw-agent-db-readers.js");
    await reviveAgentDatabases(agentIds);
  } catch (error) {
    warn(
      `agent config committed; worker reader revival will reconcile at next task: ${formatErrorMessage(error)}`,
    );
  }
}
