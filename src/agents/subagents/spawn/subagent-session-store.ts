import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { isInternalSessionEffectsKey } from "../../../config/sessions/internal-session-key.js";
import {
  loadExactSessionEntryReadOnly,
  loadSessionEntryByIdReadOnly,
} from "../../../config/sessions/session-accessor.js";
import type { SessionEntry } from "../../../config/sessions/types.js";

type PersistedSessionCapabilityEntry = Pick<
  SessionEntry,
  | "sessionId"
  | "spawnDepth"
  | "subagentRole"
  | "subagentControlScope"
  | "spawnedBy"
  | "completionOwnerSessionKey"
  | "inheritedToolPolicyVersion"
  | "inheritedToolAllow"
  | "inheritedToolDeny"
>;
export type SessionCapabilityEntry = {
  [Key in keyof PersistedSessionCapabilityEntry]?: unknown;
};

/** A complete store view; reads are memoized only for the current synchronous resolution. */
export type SessionCapabilityLookup = {
  /** Reuse this memo when depth fallback revisits the same logical store. */
  scope?: { storePath: string; agentId: string };
  get: (sessionKey: string) => SessionCapabilityEntry | undefined;
  getById: (sessionId: string) => SessionCapabilityEntry | undefined;
};

export type SessionCapabilityStore =
  | Record<string, SessionCapabilityEntry>
  | SessionCapabilityLookup;

/** Facts from an owning read in the same synchronous policy resolution. */
export type PreparedSessionCapabilityEntry = {
  sessionKey: string;
  entry: SessionCapabilityEntry;
};

export function isSessionCapabilityLookup(
  store: SessionCapabilityStore | undefined,
): store is SessionCapabilityLookup {
  return typeof store?.get === "function" && typeof store.getById === "function";
}

export function asSessionCapabilityLookup(store: SessionCapabilityStore): SessionCapabilityLookup {
  if (isSessionCapabilityLookup(store)) {
    return store;
  }
  return {
    get: (key) => store[key],
    getById: (id) => {
      const normalizedId = normalizeOptionalString(id);
      return normalizedId
        ? Object.values(store).find(
            (entry) => normalizeOptionalString(entry?.sessionId) === normalizedId,
          )
        : undefined;
    },
  };
}

/** Lazily read metadata through the session owner, never a whole-store listing. */
export function createSubagentSessionStore(
  storePath: string,
  agentId: string,
  prepared?: PreparedSessionCapabilityEntry,
): SessionCapabilityLookup {
  const entries = new Map<string, SessionCapabilityEntry | undefined>();
  const ids = new Map<string, SessionCapabilityEntry | undefined>();
  if (prepared && !isInternalSessionEffectsKey(prepared.sessionKey)) {
    entries.set(prepared.sessionKey, prepared.entry);
  }
  return {
    scope: { storePath, agentId },
    get: (sessionKey) => {
      if (!entries.has(sessionKey)) {
        let entry: SessionCapabilityEntry | undefined;
        try {
          if (!isInternalSessionEffectsKey(sessionKey)) {
            entry = loadExactSessionEntryReadOnly({
              storePath,
              agentId,
              sessionKey,
              projection: "list",
            })?.entry;
          }
        } catch {
          // Preserve the depth/key fallback for missing or unavailable stores.
        }
        entries.set(sessionKey, entry);
      }
      return entries.get(sessionKey);
    },
    getById: (sessionId) => {
      const id = normalizeOptionalString(sessionId);
      if (!id) {
        return undefined;
      }
      if (!ids.has(id)) {
        let entry: SessionCapabilityEntry | undefined;
        try {
          const selected = loadSessionEntryByIdReadOnly({
            storePath,
            agentId,
            sessionId: id,
            projection: "list",
          });
          entry = selected?.entry;
          if (selected && !entries.has(selected.sessionKey)) {
            entries.set(selected.sessionKey, selected.entry);
          }
        } catch {
          // Preserve the depth/key fallback for missing or unavailable stores.
        }
        ids.set(id, entry);
      }
      return ids.get(id);
    },
  };
}
