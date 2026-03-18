/** Shared reply-history helpers for plugins that keep short per-thread context windows. */
export type { HistoryEntry } from "../auto-reply/reply/history.js";
export {
  DEFAULT_GROUP_HISTORY_LIMIT,
  buildHistoryContext,
  buildHistoryContextFromEntries,
  buildHistoryContextFromMap,
  buildPendingHistoryContextFromMap,
  clearHistoryEntries,
  clearHistoryEntriesIfEnabled,
  evictOldHistoryKeys,
  recordPendingHistoryEntry,
  recordPendingHistoryEntryIfEnabled,
} from "../auto-reply/reply/history.js";
