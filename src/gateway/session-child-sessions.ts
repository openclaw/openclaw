import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { loadCombinedSessionStoreForGateway } from "../config/sessions/combined-store-gateway.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";

export type DirectChildSessionEntry = {
  sessionKey: string;
  entry: SessionEntry;
};

/**
 * Checks whether a store entry is a direct child of a parent session. Both
 * `spawnedBy` and `parentSessionKey` are accepted because older and newer
 * session creation paths record lineage under different fields.
 */
export function isDirectChildSessionEntry(params: {
  sessionKey: string;
  entry: SessionEntry | undefined;
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

/**
 * Finds direct children across the combined Gateway session store. Parent reset
 * and delete cleanup use this instead of one agent store so ACP children spawned
 * under another agent are still closed.
 */
export function findDirectChildSessionsForParent(params: {
  cfg: OpenClawConfig;
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
