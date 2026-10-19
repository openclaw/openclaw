import { resolveOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import { captureMemoryExactSessionReader } from "./session-accessor.memory-exact-read.js";
import { resolveSqliteSessionKey } from "./session-accessor.sqlite-scope-helpers.js";
import type { SessionEntryReadScope, SessionEntrySummary } from "./session-accessor.types.js";
import { captureSessionEntryReadScope } from "./session-entry-read-request.js";
import { withSessionStoreReaderInWorker } from "./session-entry-read-runtime.js";

/** Lists direct child rows without cloning or rebuilding the complete session store. */
export async function listSessionChildEntriesReadOnly(
  scope: SessionEntryReadScope,
  parentSessionKeys: readonly string[] = [scope.sessionKey],
): Promise<SessionEntrySummary[]> {
  const memory = captureMemoryExactSessionReader(scope);
  if (memory) {
    return memory.children(parentSessionKeys, scope.projection);
  }
  const captured = captureSessionEntryReadScope(scope);
  const storePath =
    captured.scope.storePath ??
    (captured.agentId &&
      resolveOpenClawAgentSqlitePath({ agentId: captured.agentId, env: captured.env }));
  if (!storePath) {
    throw new Error("Cannot resolve SQLite session scope without an agent id");
  }
  return withSessionStoreReaderInWorker(
    { agentId: captured.agentId, storePath, env: captured.env },
    async ({ reader, database, continuation, logicalAgentId }) => {
      const result = await reader.readExactEntries({
        selection: {
          kind: "children",
          parentSessionKeys: parentSessionKeys.map((key) =>
            resolveSqliteSessionKey(key, logicalAgentId),
          ),
        },
        projection: scope.projection === "list" ? "list" : "full",
        snapshotFields: typeof scope.projection === "object" ? scope.projection : undefined,
        env: database.env,
        continuation,
      });
      return result.entries;
    },
    { backing: true, dataOnly: true },
  );
}
