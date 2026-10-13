import { readPreparedSessionEntryChange } from "../config/sessions/session-accessor.sqlite-entry-cache-publication-state.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
import {
  prepareSessionRowPublicationScope,
  sessionChangeAffectsStoredRow,
} from "../sessions/session-row-facts.js";

type EntryState = {
  agentId: string;
  key: string;
  storePath: string;
  entry: ReturnType<typeof projectActivitySummaryEntry>;
};

/** Recap ownership retains eligibility and the saved recap, not unrelated session payloads. */
export function projectActivitySummaryEntry(entry: SessionEntry) {
  return {
    sessionId: entry.sessionId,
    updatedAt: entry.updatedAt,
    lifecycleRevision: entry.lifecycleRevision,
    activitySummary: entry.activitySummary,
    initializationPending: entry.initializationPending,
    incognito: entry.incognito,
    heartbeatIsolatedBaseSessionKey: entry.heartbeatIsolatedBaseSessionKey,
    spawnedBy: entry.spawnedBy,
    category: entry.category,
  };
}

/** Refresh tracked recap entries from the same receipts that publish committed session rows. */
export function subscribeActivitySummaryEntryReceipts<T extends EntryState>(
  states: ReadonlyMap<string, T>,
  drop: (state: T) => void,
) {
  const scopes = new WeakMap<T, ReturnType<typeof prepareSessionRowPublicationScope>>();
  return sessionChanges.subscribeFacts((change) => {
    for (const state of states.values()) {
      let scope = scopes.get(state);
      if (!scope) {
        scope = prepareSessionRowPublicationScope([state.storePath]);
        scopes.set(state, scope);
      }
      if (
        !sessionChangeAffectsStoredRow(change, {
          ...scope,
          agentId: state.agentId,
          sessionKeys: [state.key],
        })
      ) {
        continue;
      }
      const receipt = readPreparedSessionEntryChange(change, state.key);
      if (receipt?.entry) {
        state.entry = projectActivitySummaryEntry(
          receipt.fullEntry ?? { ...state.entry, ...receipt.entry },
        );
      } else if (receipt || change.factsInvalidated) {
        drop(state);
      }
    }
  });
}
