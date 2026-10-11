import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { isInternalSessionEffectsKey } from "../../../config/sessions/internal-session-key.js";
import {
  loadExactSessionEntryReadOnly,
  loadSessionEntryByIdReadOnly,
} from "../../../config/sessions/session-accessor.js";
import {
  captureSessionActorStorageOwner,
  getSessionActorStorageBinding,
  type CapturedSessionActorStorageOwner,
} from "../../../config/sessions/session-actor-storage-binding.js";
import type { SessionEntry } from "../../../config/sessions/types.js";
import { SessionRowProjectionBinding } from "../../../gateway/session-row-projection-binding.js";
import { getInProcessGatewayRequestContext } from "../../../plugins/runtime/gateway-request-scope.js";
import {
  isIncognitoSessionKey,
  resolveAgentIdFromSessionKey,
} from "../../../routing/session-key.js";
import {
  resolveExplicitIncognitoAgentSqliteTarget,
  resolveIncognitoOpenClawAgentSqlitePath,
} from "../../../state/openclaw-agent-db.paths.js";

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
  const selected = getSessionActorStorageBinding({});
  const explicit = resolveExplicitIncognitoAgentSqliteTarget(storePath, { agentId });
  const memory = new Map<string, CapturedSessionActorStorageOwner | undefined>();
  const authority = { assertCurrent() {}, authorize() {} };
  const memoryOwner = (requestedAgentId: string) => {
    if (!memory.has(requestedAgentId)) {
      memory.set(
        requestedAgentId,
        captureSessionActorStorageOwner(
          {
            agentId: requestedAgentId,
            sessionActor: selected,
            storePath:
              explicit?.agentId === requestedAgentId
                ? explicit.path
                : selected
                  ? undefined
                  : resolveIncognitoOpenClawAgentSqlitePath({
                      agentId: requestedAgentId,
                      env: explicit?.env,
                    }),
          },
          authority,
        ),
      );
    }
    const captured = memory.get(requestedAgentId);
    captured?.binding?.actor.assertReadable();
    return captured;
  };
  const readActorEntry = (sessionKey: string) => {
    const captured = memoryOwner(resolveAgentIdFromSessionKey(sessionKey));
    const query = {
      type: "session.entry.read" as const,
      input: { sessionKey, projection: "list" as const },
    };
    return captured?.owner
      ? captured.owner.readStorage(sessionKey, query, captured.authority)
      : captured?.binding?.agentId === captured?.agentId
        ? captured?.binding?.actor.storage?.readCurrent(query, captured.authority)
        : undefined;
  };
  const readActorEntryById = (sessionId: string) => {
    const captured = memoryOwner(
      isIncognitoSessionKey(sessionId) ? resolveAgentIdFromSessionKey(sessionId) : agentId,
    );
    return captured?.owner
      ? captured.owner.readSessionById(sessionId, captured.authority, { currentOnly: true })
      : captured?.binding?.agentId === captured?.agentId
        ? captured?.binding?.actor.storage?.readCurrent(
            {
              type: "session.entry.readById",
              input: { sessionId, projection: "list", currentOnly: true },
            },
            captured.authority,
          )
        : undefined;
  };
  const entries = new Map<string, SessionCapabilityEntry | undefined>();
  const ids = new Map<string, SessionCapabilityEntry | undefined>();
  if (prepared && !isInternalSessionEffectsKey(prepared.sessionKey)) {
    entries.set(prepared.sessionKey, prepared.entry);
  }
  return {
    scope: { storePath, agentId },
    get: (sessionKey) => {
      if (isIncognitoSessionKey(sessionKey)) {
        return readActorEntry(sessionKey);
      }
      if (explicit) {
        return undefined;
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
      const actorEntry = readActorEntryById(id);
      if (actorEntry || explicit || isIncognitoSessionKey(id)) {
        return actorEntry?.entry;
      }
      if (isInternalSessionEffectsKey(id)) {
        return undefined;
      }
      if (!ids.has(id)) {
        let entry: SessionCapabilityEntry | undefined;
        try {
          const row = loadSessionEntryByIdReadOnly({
            ...readScope,
            sessionId: id,
          });
          entry = row?.entry;
          if (row && !entries.has(row.sessionKey)) {
            entries.set(row.sessionKey, row.entry);
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
