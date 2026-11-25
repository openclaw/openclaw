import type { DatabaseSync } from "node:sqlite";
import { sessionEntryCaches } from "./session-accessor.sqlite-entry-cache-state.js";

/** Inspect owner-held facts without populating or refreshing the cache. */
export function readCommittedSessionEntryCache(database: DatabaseSync) {
  return sessionEntryCaches.get(database)?.entries;
}
