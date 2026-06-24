// Runtime facade for session store mutation helpers.
export {
  applySessionStoreEntryPatch,
  cleanupSessionLifecycleArtifacts,
  updateSessionStore,
  updateSessionStoreEntry,
} from "./store.js";
export { deleteSessionEntryLifecycle, resetSessionEntryLifecycle } from "./session-accessor.js";
export type {
  SessionLifecycleArtifactCleanupParams,
  SessionLifecycleArtifactCleanupResult,
} from "./store.js";
export type {
  DeleteSessionEntryLifecycleResult,
  ResetSessionEntryLifecycleResult,
  SessionLifecycleArchivedTranscript,
  SessionLifecycleStoreTarget,
} from "./session-accessor.js";
