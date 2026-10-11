import type { SessionActorReducer } from "./session-actor-contract.js";
import { projectSessionEntryUsageUpdate } from "./session-entry-usage.js";
import type { InternalSessionEntry as SessionEntry } from "./types.js";

/** Reduce only bookkeeping; lifecycle and custody belong to the phase command. */
export function reduceSessionActorEntry(
  entry: SessionEntry,
  reducers: readonly SessionActorReducer[],
): SessionEntry {
  const next = structuredClone(entry);
  for (const reducer of reducers) {
    switch (reducer.kind) {
      case "activity":
        next.updatedAt = Math.max(next.updatedAt, reducer.updatedAt);
        break;
      case "usage":
        Object.assign(
          next,
          projectSessionEntryUsageUpdate(next, reducer.update, reducer.updatedAt),
        );
        break;
      case "group-intro":
        next.groupActivationNeedsSystemIntro = reducer.needsSystemIntro;
        break;
      case "fallback-notice":
        next.fallbackNotice = structuredClone(reducer.notice);
        break;
      case "live-model": {
        if (
          next.modelProvider !== reducer.expected.modelProvider ||
          next.model !== reducer.expected.model ||
          next.agentHarnessId !== reducer.expected.agentHarnessId
        ) {
          throw new Error("Session actor model changed before consolidation");
        }
        Object.assign(next, reducer.next);
        break;
      }
    }
  }
  return next;
}
