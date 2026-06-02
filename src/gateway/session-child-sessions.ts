import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { loadCombinedSessionStoreForGateway } from "../config/sessions/combined-store-gateway.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";

export type DirectChildSessionEntry = {
  /** Canonical session key for a direct child of the requested parent. */
  sessionKey: string;
  /** Session-store entry carrying the child lineage metadata. */
  entry: SessionEntry;
};

/** Return true when a store entry is a direct child of the given parent session key. */
export function isDirectChildSessionEntry(params: {
  /** Candidate child session key from the combined store. */
  sessionKey: string;
  /** Candidate store entry; missing entries are never children. */
  entry: SessionEntry | undefined;
  /** Parent session key to match against spawnedBy or parentSessionKey. */
  parentKey: string;
}): boolean {
  const parentKey = normalizeOptionalString(params.parentKey);
  if (!parentKey || params.sessionKey === parentKey || !params.entry) {
    return false;
  }
  return (
    normalizeOptionalString(params.entry.spawnedBy) === parentKey ||
    normalizeOptionalString(params.entry.parentSessionKey) === parentKey
  );
}

/** Find direct child sessions for a parent across the combined Gateway session store. */
export function findDirectChildSessionsForParent(params: {
  /** Active config used to load all visible session stores. */
  cfg: OpenClawConfig;
  /** Parent session key to match against child lineage fields. */
  parentKey: string;
}): DirectChildSessionEntry[] {
  const { store } = loadCombinedSessionStoreForGateway(params.cfg);
  return Object.entries(store)
    .filter(([sessionKey, entry]) =>
      isDirectChildSessionEntry({
        sessionKey,
        entry,
        parentKey: params.parentKey,
      }),
    )
    .map(([sessionKey, entry]) => ({ sessionKey, entry }));
}
