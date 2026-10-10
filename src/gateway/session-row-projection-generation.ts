import { readPreparedSessionSharingChange } from "../config/sessions/session-accessor.sqlite-entry-cache-publication.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeAgentId, parseAgentSessionKey } from "../routing/session-key.js";
import type { SessionIdentityMutation } from "../sessions/session-lifecycle-events.js";
import * as records from "./session-row-projection-record.js";
import { resolveStoredSessionKeyForAgentStore } from "./session-store-key.js";

type ObservationQuery = { agentId: string; storePath?: string } & (
  | { key: string; sessionId?: never }
  | { sessionId: string; key?: never }
);

/** Pending events observe mutations in the same owner that renews published row generations. */
export function createSessionRowGenerationObservations(owner: {
  config: () => OpenClawConfig;
  isActive: () => boolean;
  stores: () => ReadonlyMap<string, records.SessionRowStore>;
  isCurrent: (row: records.Row) => boolean;
  matching: (query: records.Query) => records.Row[];
  markRelated: (row: records.Row) => void;
  put: (row: records.Row) => void;
  remove: (id: string) => void;
  dirty: Set<string>;
  mark: (change: { agentId: string; sessionKey: string; storePath?: string }) => void;
  ensureMaterialized: () => Promise<void>;
}) {
  const observations = new Set<{
    changed: (mutation: SessionIdentityMutation) => boolean;
    dispose: () => void;
  }>();
  return {
    invalidate(this: void) {
      for (const observation of observations) {
        observation.dispose();
      }
    },
    observeGeneration(this: void, query: ObservationQuery) {
      if (!owner.isActive()) {
        return { isCurrent: () => false, dispose: () => {} };
      }
      const config = owner.config();
      const agentId = normalizeAgentId(query.agentId);
      const sessionId = query.sessionId;
      const canonicalKey = (sessionKey: string) =>
        resolveStoredSessionKeyForAgentStore({ cfg: config, agentId, sessionKey });
      const key = query.key === undefined ? undefined : canonicalKey(query.key);
      let active = true;
      const observation = {
        changed(mutation: SessionIdentityMutation) {
          const targets = [mutation.previous, ...("current" in mutation ? [mutation.current] : [])];
          return targets.some((target) => {
            const keys = target.sessionKeys.filter(
              (sessionKey) =>
                normalizeAgentId(parseAgentSessionKey(sessionKey)?.agentId ?? mutation.agentId) ===
                agentId,
            );
            // ID-only markers can name a physical shared owner before logical ownership is known.
            return key === undefined
              ? target.sessionId === sessionId
              : keys.some((sessionKey) => canonicalKey(sessionKey) === key);
          });
        },
        dispose(this: void) {
          active = false;
          observations.delete(observation);
        },
      };
      observations.add(observation);
      return {
        isCurrent(row: records.Row) {
          if (
            !active ||
            !owner.isActive() ||
            (row.agentId !== agentId &&
              (key !== undefined || row.storeTarget.agentId !== agentId)) ||
            !owner.isCurrent(row) ||
            (key === undefined ? row.entry?.sessionId !== sessionId : canonicalKey(row.key) !== key)
          ) {
            return false;
          }
          return true;
        },
        dispose: observation.dispose,
      };
    },
    mutate(this: void, mutation: SessionIdentityMutation) {
      for (const observation of observations) {
        if (observation.changed(mutation)) {
          observation.dispose();
        }
      }
      // Committed receipts have already updated the resident row.
      if (readPreparedSessionSharingChange(mutation) !== undefined) {
        return;
      }
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
