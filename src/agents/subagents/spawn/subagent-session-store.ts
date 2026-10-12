import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { isInternalSessionEffectsKey } from "../../../config/sessions/internal-session-key.js";
import {
  loadExactSessionEntryReadOnly,
  loadSessionEntryByIdReadOnly,
} from "../../../config/sessions/session-accessor.js";
import {
  captureIncognitoSessionSource,
  captureIncognitoSessionTopology,
} from "../../../config/sessions/session-incognito-binding.js";
import type { SessionEntry } from "../../../config/sessions/types.js";
import { SessionRowProjectionBinding } from "../../../gateway/session-row-projection-binding.js";
import { getInProcessGatewayRequestContext } from "../../../plugins/runtime/gateway-request-scope.js";
import {
  isIncognitoSessionKey,
  resolveAgentIdFromSessionKey,
} from "../../../routing/session-key.js";

type PersistedSessionCapabilityEntry = Pick<
  SessionEntry,
  | "sessionId"
  | "spawnDepth"
  | "subagentRole"
  | "subagentControlScope"
  | "spawnedBy"
  | "completionOwnerSessionKey"
  | "inheritedToolPolicyVersion"
  | "inheritedToolPolicySource"
  | "inheritedToolAllow"
  | "inheritedToolDeny"
  | "delegatedToolPolicy"
>;
export type SessionCapabilityEntry = {
  [Key in keyof PersistedSessionCapabilityEntry]?: unknown;
};

/** A complete store view; reads are memoized only for the current synchronous resolution. */
export type SessionCapabilityLookup = {
  /** Cross-agent owner projection: missing rows are authoritative, never a database fallback. */
  authoritative?: true;
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
  const readScope = { storePath, agentId, projection: "list" as const };
  const source = captureIncognitoSessionSource();
  const byIdSource = captureIncognitoSessionSource({ storePath, agentId });
  const topology = source && !("kind" in source) ? captureIncognitoSessionTopology() : undefined;
  const readActorEntry = (sessionKey: string) => {
    source?.admissionSignal?.throwIfAborted();
    if (!source || "kind" in source) {
      source?.assertCurrent();
      if (source && resolveAgentIdFromSessionKey(sessionKey) !== source.agentId) {
        throw new Error("Session target belongs to another incognito actor");
      }
      return undefined;
    }
    source.actor.assertReadable();
    const owner = topology?.entries.find(
      (entry) => entry.agentId === resolveAgentIdFromSessionKey(sessionKey),
    );
    owner?.assertCurrent();
    return owner?.facts.readCapability(sessionKey);
  };
  const entries = new Map<string, SessionCapabilityEntry | undefined>();
  const ids = new Map<string, SessionCapabilityEntry | undefined>();
  if (prepared && !isInternalSessionEffectsKey(prepared.sessionKey)) {
    entries.set(prepared.sessionKey, prepared.entry);
  }
  return {
    scope: { storePath, agentId },
    get: (sessionKey) => {
      if (source && isIncognitoSessionKey(sessionKey)) {
        return readActorEntry(sessionKey);
      }
      if (!entries.has(sessionKey)) {
        if (isInternalSessionEffectsKey(sessionKey)) {
          entries.set(sessionKey, undefined);
          return undefined;
        }
        const owner = getInProcessGatewayRequestContext()?.sessionRowProjectionOwner;
        let entry: SessionCapabilityEntry | undefined =
          owner instanceof SessionRowProjectionBinding
            ? owner.readCommittedEntry({ agentId, key: sessionKey, storePath })
            : undefined;
        if (!entry) {
          try {
            entry = loadExactSessionEntryReadOnly({
              ...readScope,
              sessionKey,
            })?.entry;
          } catch {
            // Preserve the depth/key fallback for missing or unavailable stores.
          }
        }
        entries.set(sessionKey, entry);
      }
      return entries.get(sessionKey);
    },
    getById: (requestedSessionId) => {
      const id = normalizeOptionalString(requestedSessionId);
      if (!id) {
        return undefined;
      }
      if (byIdSource) {
        byIdSource.admissionSignal?.throwIfAborted();
        if ("kind" in byIdSource) {
          byIdSource.assertCurrent();
          return undefined;
        }
        byIdSource.actor.assertReadable();
        const candidates = byIdSource.actor.sessions
          .deadlines()
          .filter(({ sessionKey }) => !isInternalSessionEffectsKey(sessionKey))
          .toSorted((left, right) =>
            left.sessionKey < right.sessionKey ? -1 : left.sessionKey > right.sessionKey ? 1 : 0,
          );
        const selected =
          candidates.find(({ sessionId }) => sessionId === id) ??
          candidates.find(({ sessionId }) => normalizeOptionalString(sessionId) === id);
        return selected ? byIdSource.actor.sessions.readCapability(selected.sessionKey) : undefined;
      }
      if (source && isIncognitoSessionKey(id)) {
        readActorEntry(id);
        return undefined;
      }
      if (!ids.has(id)) {
        let entry: SessionCapabilityEntry | undefined;
        try {
          const selected = loadSessionEntryByIdReadOnly({
            ...readScope,
            sessionId: id,
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
