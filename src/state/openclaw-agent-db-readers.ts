import path from "node:path";
import {
  applyAgentDatabaseReaderRequest,
  encodeAgentDatabaseReaderRequest,
  type AgentDatabaseReaderRequest,
} from "../infra/agent-database-readers.js";
import { retireSqliteDatabaseAdmissionForPath } from "../infra/sqlite-database-admission.js";
import { closeWorkerTaskPoolResources } from "../infra/worker-task-pool-registry.js";

async function applyAcrossProcess(request: AgentDatabaseReaderRequest): Promise<void> {
  await applyAgentDatabaseReaderRequest(request);
  await closeWorkerTaskPoolResources(encodeAgentDatabaseReaderRequest(request));
}

/** Deletion closes the databases everywhere and refuses reopening them until the agent returns. */
export async function closeDeletedAgentDatabases(
  agentId: string,
  databasePaths: readonly string[],
  authority: { assertCurrentFinal(): void; assertCurrentAsync(): Promise<void> },
): Promise<void> {
  await authority.assertCurrentAsync();
  const candidates = [...new Set(databasePaths.map((pathname) => path.resolve(pathname)))].map(
    (pathname) => ({ path: pathname }),
  );
  if (candidates.length > 0) {
    await applyAcrossProcess({ kind: "close", candidates, deleted: true, agentId });
    for (const candidate of candidates) {
      authority.assertCurrentFinal();
      retireSqliteDatabaseAdmissionForPath(candidate.path);
    }
  }
  await authority.assertCurrentAsync();
}

/** Re-admission revives only the physical paths captured for these deleted owners. */
export async function reviveAgentDatabases(agentIds: readonly string[]): Promise<void> {
  const unique = [...new Set(agentIds)];
  if (unique.length > 0) {
    await applyAcrossProcess({ kind: "revive", agentIds: unique });
  }
}
