import path from "node:path";
import {
  applyAgentDatabaseReaderRequest,
  encodeAgentDatabaseReaderRequest,
  type AgentDatabaseReaderRequest,
} from "../infra/agent-database-readers.js";
import { closeWorkerTaskPoolResources } from "../infra/worker-task-pool-registry.js";

async function applyAcrossProcess(request: AgentDatabaseReaderRequest): Promise<void> {
  await applyAgentDatabaseReaderRequest(request);
  await closeWorkerTaskPoolResources(encodeAgentDatabaseReaderRequest(request));
}

function resolveUnique(pathnames: readonly string[]): string[] {
  return [...new Set(pathnames.map((pathname) => path.resolve(pathname)))];
}

/** Deletion closes the databases everywhere and refuses reopening them until the agent returns. */
export async function closeDeletedAgentDatabases(
  agentId: string,
  databasePaths: readonly string[],
): Promise<void> {
  const candidates = resolveUnique(databasePaths).map((pathname) => ({ path: pathname }));
  if (candidates.length > 0) {
    await applyAcrossProcess({ kind: "close", candidates, deleted: true, agentId });
  }
}

/** Re-admission revives only the physical paths captured for these deleted owners. */
export async function reviveAgentDatabases(agentIds: readonly string[]): Promise<void> {
  const unique = [...new Set(agentIds)];
  if (unique.length > 0) {
    await applyAcrossProcess({ kind: "revive", agentIds: unique });
  }
}
