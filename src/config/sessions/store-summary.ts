import { readSessionStoreReadOnly } from "./store-read.js";

export type SessionStoreSummaryEntry = {
  lastChannel?: string;
  lastTo?: string;
  updatedAt?: number;
};

// Heartbeat recipient resolution only needs a shallow snapshot of the session
// store. A direct read avoids dragging in the full session maintenance/cache
// stack on cold imports.
export function loadSessionStoreSummary(
  storePath: string,
): Record<string, SessionStoreSummaryEntry> {
  const store = readSessionStoreReadOnly(storePath);
  const summary: Record<string, SessionStoreSummaryEntry> = {};

  for (const [sessionKey, entry] of Object.entries(store)) {
    if (!entry) {
      continue;
    }
    summary[sessionKey] = {
      lastChannel: entry.lastChannel,
      lastTo: entry.lastTo,
      updatedAt: entry.updatedAt,
    };
  }

  return summary;
}
