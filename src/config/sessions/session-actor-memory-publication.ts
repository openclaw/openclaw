import { sessionChanges, type SessionRowChange } from "../../sessions/session-row-changes.js";
import { bindPreparedSessionEntryPublication } from "./session-accessor.sqlite-entry-cache-publication.js";
import { publishCommittedSessionIdentity } from "./session-accessor.sqlite-identity.js";
import type { SessionActorStorageChange } from "./session-actor-storage-contract.js";

/** The owner installs all state before publishing its complete committed facts. */
export function publishSessionActorMemoryChanges(
  owner: { agentId: string; path: string; incarnation: string },
  changes: readonly SessionActorStorageChange[],
): void {
  for (const { sessionKey, before, after } of changes) {
    const entry = after?.entry;
    const change: SessionRowChange = {
      agentId: owner.agentId,
      storePath: owner.path,
      sessionKey,
      facts:
        entry && after
          ? {
              kind: "replacement",
              membership: [
                sessionKey,
                entry.category ?? null,
                after.members.map(({ identityId }) => identityId),
                { participants: entry.participants, participantCount: entry.participantCount },
                entry.sessionId,
              ],
              lifecycleChanged:
                before?.entry?.sessionId !== entry.sessionId ||
                before?.entry?.lifecycleRevision !== entry.lifecycleRevision,
            }
          : { kind: "removed" },
    };
    bindPreparedSessionEntryPublication(change, {
      kind: "source",
      databaseIdentity: owner.incarnation,
      canonicalPath: owner.path,
    });
    sessionChanges.emit(change);
  }
  publishCommittedSessionIdentity(
    owner.agentId,
    owner.incarnation,
    new Map(
      changes.flatMap(({ sessionKey, before }) =>
        before?.entry ? [[sessionKey, before.entry]] : [],
      ),
    ),
    new Map(
      changes.flatMap(({ sessionKey, after }) => (after?.entry ? [[sessionKey, after.entry]] : [])),
    ),
  );
}
