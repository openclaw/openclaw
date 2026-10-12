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
  entry: SessionEntry;
};

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
        state.entry = receipt.fullEntry ?? { ...state.entry, ...receipt.entry };
      } else if (receipt || change.factsInvalidated) {
        drop(state);
      }
    }
  });
}
