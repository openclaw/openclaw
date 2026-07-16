import { createDedupeCache, type DedupeCache } from "../infra/dedupe.js";

const MAX_LOGGED_INVALID_CONFIGS = 4096;
export const MAX_LOGGED_CONFIG_WARNING_FINGERPRINTS = 4096;
const MAX_WARNED_FUTURE_TOUCHED_VERSIONS = 4096;
export const MAX_AUTO_OWNER_DISPLAY_SECRET_BY_PATH = 4096;

// Warning state spans fresh config snapshots; bounding it means evicted paths can re-warn.
export const loggedInvalidConfigs: DedupeCache = createDedupeCache({
  ttlMs: 0,
  maxSize: MAX_LOGGED_INVALID_CONFIGS,
});

export const loggedConfigWarningFingerprints = new Map<string, string>();

// Warning state spans fresh config snapshots; bounding it means evicted versions can re-warn.
export const warnedFutureTouchedVersions: DedupeCache = createDedupeCache({
  ttlMs: 0,
  maxSize: MAX_WARNED_FUTURE_TOUCHED_VERSIONS,
});

export const autoOwnerDisplaySecretByPath = new Map<string, string>();
