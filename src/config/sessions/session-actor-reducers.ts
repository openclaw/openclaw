import type { SessionActorReducer } from "./session-actor-contract.js";
import { reduceSessionBookkeeping } from "./session-entry-patch-operation.js";
import type { InternalSessionEntry as SessionEntry } from "./types.js";

/** Closed bookkeeping reducers replace fields; nested preimage values stay read-only. */
export function reduceSessionActorEntry(
  entry: SessionEntry,
  reducers: readonly SessionActorReducer[],
): SessionEntry {
  const next = { ...entry };
  for (const reducer of reducers) {
    const patch = reduceSessionBookkeeping(next, reducer);
    if (patch) {
      Object.assign(next, patch);
    }
  }
  return next;
}
