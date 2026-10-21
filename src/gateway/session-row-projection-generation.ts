import { readPreparedSessionSharingChange } from "../config/sessions/session-accessor.sqlite-entry-cache-publication.js";
import type { SessionIdentityMutation } from "../sessions/session-lifecycle-events.js";
import * as records from "./session-row-projection-record.js";

/** Apply committed identity mutations to the resident row owner. */
export function createSessionRowGenerationMutations(owner: {
  stores: () => ReadonlyMap<string, records.SessionRowStore>;
  matching: (query: records.Query) => records.Row[];
  markRelated: (row: records.Row) => void;
  put: (row: records.Row) => void;
  remove: (id: string) => void;
  dirty: Set<string>;
  mark: (change: { agentId: string; sessionKey: string; storePath?: string }) => void;
  ensureMaterialized: () => Promise<void>;
}) {
  return {
    mutate(this: void, mutation: SessionIdentityMutation) {
      // Committed receipts have already updated the resident row.
      if (readPreparedSessionSharingChange(mutation) !== undefined) {
        return;
      }
      // Native writes publish their row before the identity notification.
      const alreadyPublished = (row: records.Row) =>
        mutation.kind !== "delete" &&
        mutation.kind !== "reset" &&
        mutation.current.sessionKeys.includes(row.key) &&
        row.publishedSource?.identity === mutation.databaseIdentity &&
        row.sharingEntry?.sessionId === mutation.current.sessionId;
      for (const key of mutation.previous.sessionKeys) {
        for (const row of owner.matching({ key, agentId: mutation.agentId })) {
          if (
            owner.stores().get(row.storeTarget.storePath)?.identity !== mutation.databaseIdentity
          ) {
            continue;
          }
          if (mutation.previous.sessionId && row.entry?.sessionId !== mutation.previous.sessionId) {
            continue;
          }
          if (alreadyPublished(row)) {
            continue;
          }
          owner.markRelated(row);
          if ("current" in mutation && mutation.current.sessionKeys.includes(row.key)) {
            owner.put(records.renewGeneration(row));
            owner.dirty.add(records.identity(row));
          } else {
            owner.remove(records.identity(row));
          }
        }
      }
      if ("current" in mutation) {
        const source = [...owner.stores().values()].find(
          (store) => store.identity === mutation.databaseIdentity,
        );
        if (!source) {
          return;
        }
        for (const sessionKey of mutation.current.sessionKeys) {
          if (
            owner
              .matching({ key: sessionKey, agentId: mutation.agentId })
              .some(
                (row) =>
                  owner.stores().get(row.storeTarget.storePath)?.identity ===
                    mutation.databaseIdentity && alreadyPublished(row),
              )
          ) {
            continue;
          }
          owner.mark({
            agentId: mutation.agentId,
            sessionKey,
            storePath: source.filename,
          });
        }
      } else {
        void owner.ensureMaterialized().catch(() => {});
      }
    },
  };
}
