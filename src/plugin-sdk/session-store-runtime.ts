// Narrow SQLite session row helpers for channel hot paths.
// Companions should discover owned transcript scope from session rows/session
// keys first, then project the resolved transcript scope. Maintenance-only
// transcripts may exist without a canonical session row and are not the primary
// discovery surface.
export { resolveSessionRowEntry } from "../config/sessions/store-entry.js";
export { resolveAndPersistSessionTranscriptScope } from "../config/sessions/session-scope.js";
export { resolveSessionKey } from "../config/sessions/session-key.js";
export { resolveGroupSessionKey } from "../config/sessions/group.js";
export { canonicalizeMainSessionAlias } from "../config/sessions/main-session.js";
export {
  deleteSessionEntry,
  getSessionEntry,
  listSessionEntries,
  patchSessionEntry,
  readSessionUpdatedAt,
  recordSessionMetaFromInbound,
  updateLastRoute,
  upsertSessionEntry,
} from "../config/sessions/store.js";
export {
  loadActiveSqliteSessionTranscriptProjections,
  loadSqliteSessionTranscriptEvents,
  loadSqliteSessionTranscriptProjections,
  projectSqliteSessionTranscriptEvent,
  replaceSqliteSessionTranscriptEvents,
  selectActiveSqliteSessionTranscriptProjections,
} from "../config/sessions/transcript-store.sqlite.js";
export type {
  SqliteSessionTranscriptEvent,
  SqliteSessionTranscriptMessageRole,
  SqliteSessionTranscriptProjectedEvent,
} from "../config/sessions/transcript-store.sqlite.js";
export {
  evaluateSessionFreshness,
  resolveChannelResetConfig,
  resolveSessionResetPolicy,
  resolveSessionResetType,
  resolveThreadFlag,
} from "../config/sessions/reset.js";
export type { SessionEntry, SessionScope } from "../config/sessions/types.js";
