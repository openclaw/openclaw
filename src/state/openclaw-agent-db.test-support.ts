import { agentDatabaseLifecycle as cache } from "./openclaw-agent-db-lifecycle.js";

/** List process-held agent databases without opening or inspecting fixture state. */
export function listOpenClawAgentDatabasesForTest(): Array<{ agentId: string; path: string }> {
  return [...cache.databases.values()]
    .filter((database) => database.db.isOpen)
    .map((database) => ({ agentId: database.agentId, path: database.path }))
    .toSorted(
      (left, right) =>
        left.agentId.localeCompare(right.agentId) || left.path.localeCompare(right.path),
    );
}
