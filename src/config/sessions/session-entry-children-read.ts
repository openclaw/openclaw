import { isIncognitoSessionKey } from "../../routing/session-key.js";
import { resolveOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import { resolveSqliteSessionKey } from "./session-accessor.sqlite-scope-helpers.js";
import type { SessionEntryReadScope, SessionEntrySummary } from "./session-accessor.types.js";
import { getSessionActorStorageBinding } from "./session-actor-storage-binding.js";
import { listIncognitoSessionChildEntriesReadOnly } from "./session-entry-children-incognito.js";
import { captureSessionEntryReadScope } from "./session-entry-read-request.js";
import { withSessionStoreReaderInWorker } from "./session-entry-read-runtime.js";

/** Lists direct child rows without cloning or rebuilding the complete session store. */
export async function listSessionChildEntriesReadOnly(
  scope: SessionEntryReadScope,
  parentSessionKeys: readonly string[] = [scope.sessionKey],
): Promise<SessionEntrySummary[]> {
  const parents = new Set(parentSessionKeys);
  const memory = getSessionActorStorageBinding({ ...scope, sessionKey: undefined });
  if (memory) {
    return memory.actor
      .storage!.readCurrent(
        { type: "session.entries.read", input: { projection: scope.projection } },
        memory.authority,
      )
      .filter(
        ({ sessionKey, entry }) =>
          !parents.has(sessionKey) &&
          (parents.has(entry.parentSessionKey ?? "") || parents.has(entry.spawnedBy ?? "")),
      )
      .toSorted((a, b) => a.sessionKey.localeCompare(b.sessionKey));
  }
  // Native incognito ownership is retired separately from durable worker reads.
  if (isIncognitoSessionKey(scope.sessionKey)) {
    return listIncognitoSessionChildEntriesReadOnly(scope);
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
