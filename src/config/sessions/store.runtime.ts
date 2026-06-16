// Runtime facade for session store mutation helpers.
export {
  applySessionStoreEntryPatch,
  cleanupSessionLifecycleArtifacts,
  updateSessionStore,
  updateSessionStoreEntry,
} from "./store.js";
export type {
  SessionLifecycleArtifactCleanupParams,
  SessionLifecycleArtifactCleanupResult,
} from "./store.js";
