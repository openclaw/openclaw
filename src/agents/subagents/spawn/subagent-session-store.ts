import { AsyncLocalStorage } from "node:async_hooks";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { isInternalSessionEffectsKey } from "../../../config/sessions/internal-session-key.js";
import { retainPreparedSessionEntryPredicate } from "../../../config/sessions/session-accessor.sqlite-entry-cache-publication-state.js";
import { readCommittedIncognitoSessionSharing } from "../../../config/sessions/session-accessor.sqlite-incognito-sharing.js";
import {
  captureSessionActorStorageOwner,
  getSessionActorStorageBinding,
  type SelectedSessionActorStorageBinding,
} from "../../../config/sessions/session-actor-storage-binding.js";
import { projectSessionEntryCapabilityFacts } from "../../../config/sessions/session-entry-capability-facts.js";
import {
  captureIncognitoSessionSource,
  captureIncognitoSessionTopology,
} from "../../../config/sessions/session-incognito-binding.js";
import type { SessionEntry } from "../../../config/sessions/types.js";
import { SessionRowProjectionBinding } from "../../../gateway/session-row-projection-binding.js";
import { getInProcessGatewayRequestContext } from "../../../plugins/runtime/gateway-request-scope.js";
import {
  isIncognitoSessionKey,
  parseAgentSessionKey,
  resolveAgentIdFromSessionKey,
} from "../../../routing/session-key.js";
import { onSessionIdentityMutation } from "../../../sessions/session-lifecycle-events.js";
import { sessionChanges } from "../../../sessions/session-row-changes.js";
import { getOpenIncognitoAgentDatabase } from "../../../state/openclaw-agent-db-lifecycle.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../../../state/openclaw-agent-db.paths.js";

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

/** Capture the selected memory owner while reading its current policy at each effect. */
export function createMemorySessionCapabilityStore(
  memory: SelectedSessionActorStorageBinding | undefined = getSessionActorStorageBinding({}),
): SessionCapabilityLookup | undefined {
  if (!memory) {
    return undefined;
  }
  const storage = memory.actor.storage;
  const owners = new Map<string, ReturnType<typeof captureSessionActorStorageOwner>>();
  return {
    authoritative: true,
    get(sessionKey) {
      const agentId = parseAgentSessionKey(sessionKey)?.agentId;
      if (agentId === memory.agentId) {
        const entry = storage.readCurrent(
          { type: "session.entry.read", input: { sessionKey, projection: "list" } },
          memory.authority,
        );
        return entry && projectSessionEntryCapabilityFacts(entry);
      }
      if (!agentId || !isIncognitoSessionKey(sessionKey)) {
        throw new Error("Completion lineage requires its selected session actor owner");
      }
      if (!owners.has(agentId)) {
        owners.set(agentId, captureSessionActorStorageOwner({ agentId, sessionActor: memory }));
      }
      const selected = owners.get(agentId);
      const entry = selected?.owner?.readSession(sessionKey, selected.authority)?.entry;
      return entry && projectSessionEntryCapabilityFacts(entry);
    },
    getById(sessionId) {
      const row = storage.readCurrent(
        {
          type: "session.entry.readById",
          input: { sessionId, projection: "list", currentOnly: true },
        },
        memory.authority,
      );
      return row && projectSessionEntryCapabilityFacts(row.entry);
    },
  };
}

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

export type SessionCapabilityRead = { storePath: string; agentId: string } & (
  | { sessionKey: string; sessionId?: never }
  | { sessionId: string; sessionKey?: never }
);

class SessionCapabilityReadRequired extends Error {
  constructor(readonly query: SessionCapabilityRead) {
    super("Session capability metadata requires worker preparation");
  }
}

const preparedReads = new AsyncLocalStorage<
  Map<string, () => SessionCapabilityEntry | undefined>
>();
const legacyReader = new AsyncLocalStorage<
  (query: SessionCapabilityRead) => SessionCapabilityEntry | undefined
>();
const readKey = (query: SessionCapabilityRead) => JSON.stringify(query);

/** Only deprecated synchronous SDK adapters may install their compatibility reader. */
export function withLegacySessionCapabilityReader<T>(
  reader: (query: SessionCapabilityRead) => SessionCapabilityEntry | undefined,
  read: () => T,
): T {
  return legacyReader.run(reader, read);
}

/** Prepare only the metadata a synchronous capability policy actually consumes. */
export async function withPreparedSessionCapabilityRead<T>(
  read: () => T,
  options?: { retain?: boolean },
): Promise<T> {
  const prepared = await prepareCapabilityReads(read, options?.retain === true);
  try {
    return await prepared.value;
  } finally {
    prepared.release();
  }
}

/** Retain worker-prepared policy until its existing writer receipt invalidates the facts. */
export async function prepareSessionCapabilityRead<T>(read: () => T) {
  const prepared = await prepareCapabilityReads(read, true);
  return { read: prepared.read, release: prepared.release };
}

async function prepareCapabilityReads<T>(read: () => T, retain: boolean) {
  const entries = new Map(preparedReads.getStore());
  const releases: Array<() => void> = [];
  let active = true;
  const release = () => {
    active = false;
    for (const cleanup of releases.splice(0)) {
      cleanup();
    }
  };
  const replay = () => {
    if (!active) {
      throw new Error("Session capability read is no longer active");
    }
    return preparedReads.run(entries, read);
  };
  try {
    for (;;) {
      try {
        return { value: replay(), read: replay, release };
      } catch (error) {
        if (!(error instanceof SessionCapabilityReadRequired)) {
          throw error;
        }
        const { withSessionEntriesFromStoreInWorker } =
          await import("../../../config/sessions/session-entry-read-runtime.js");
        const query = error.query;
        let missingCurrent = true;
        if (retain) {
          releases.push(
            sessionChanges.subscribeFacts((change) => {
              if (
                "all" in change ||
                (change.scope !== "automation" &&
                  (!change.agentId || change.agentId === query.agentId))
              ) {
                missingCurrent = false;
              }
            }),
          );
        }
        try {
          let capturedIdentity: string | undefined;
          const reader = await withSessionEntriesFromStoreInWorker(
            {
              storePath: query.storePath,
              agentId: query.agentId,
              ...(query.sessionKey !== undefined
                ? {
                    projection: "full" as const,
                    snapshotFields: [],
                    sessionKeys: [query.sessionKey],
                  }
                : {
                    projection: "sharing" as const,
                    selection: { kind: "session-id", sessionId: query.sessionId } as const,
                  }),
            },
            async ({ result }) => {
              const selected = result.entries[0];
              const entry = selected?.entry;
              if (!retain) {
                return () => entry;
              }
              const databaseIdentity = result.source?.databaseIdentity ?? capturedIdentity;
              if (!databaseIdentity) {
                return () => {
                  if (!missingCurrent) {
                    throw new Error("Session capability metadata changed", { cause: error });
                  }
                  return undefined;
                };
              }
              const predicate = retainPreparedSessionEntryPredicate({
                databaseIdentity: `file:${databaseIdentity}`,
                sessionKey: selected?.sessionKey ?? query.sessionKey ?? "",
                entry,
                matches: (before, after) =>
                  JSON.stringify(before && projectSessionEntryCapabilityFacts(before)) ===
                  JSON.stringify(after && projectSessionEntryCapabilityFacts(after)),
              });
              releases.push(predicate.release);
              let idCurrent = true;
              if (query.sessionId !== undefined) {
                releases.push(
                  onSessionIdentityMutation((change) => {
                    if (
                      change.databaseIdentity === databaseIdentity &&
                      [
                        change.previous.sessionId,
                        change.kind === "delete" ? undefined : change.current.sessionId,
                      ].some((id) => id?.trim() === query.sessionId)
                    ) {
                      idCurrent = false;
                    }
                  }),
                );
              }
              return () => {
                if (!predicate.isCurrent() || !idCurrent) {
                  throw new Error("Session capability metadata changed", { cause: error });
                }
                return entry;
              };
            },
            false,
            retain
              ? (_database, identity) => {
                  capturedIdentity = identity.key.startsWith("file:")
                    ? identity.key.slice(5)
                    : undefined;
                }
              : undefined,
          );
          entries.set(readKey(query), reader);
        } catch {
          // Missing or unreadable stores retain the policy's key/depth fallback.
          entries.set(readKey(query), () => {
            if (retain && !missingCurrent) {
              throw new Error("Session capability metadata changed", { cause: error });
            }
            return undefined;
          });
        }
      }
    }
  } catch (error) {
    release();
    throw error;
  }
}

/** Read the existing owner projection; standalone policy resolution prepares worker facts first. */
export function createSubagentSessionStore(
  storePath: string,
  agentId: string,
  prepared?: PreparedSessionCapabilityEntry,
): SessionCapabilityLookup {
  const readScope = { storePath, agentId };
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
  if (prepared && !isInternalSessionEffectsKey(prepared.sessionKey)) {
    entries.set(prepared.sessionKey, prepared.entry);
  }
  let preparedEntries = preparedReads.getStore();
  const readDurable = (query: SessionCapabilityRead) => {
    if (query.sessionKey !== undefined && isIncognitoSessionKey(query.sessionKey)) {
      const pathname = resolveIncognitoOpenClawAgentSqlitePath({ agentId: query.agentId });
      const database = getOpenIncognitoAgentDatabase(query.agentId, pathname);
      const facts = database && readCommittedIncognitoSessionSharing(database.db, query.sessionKey);
      if (facts?.entry && !facts.capability) {
        throw new Error("Session capability metadata is unavailable");
      }
      return facts?.capability;
    }
    const owner = getInProcessGatewayRequestContext()?.sessionRowProjectionOwner;
    const current =
      owner instanceof SessionRowProjectionBinding
        ? owner.readCommittedEntry({
            agentId: query.agentId,
            storePath: query.storePath,
            ...(query.sessionKey !== undefined
              ? { key: query.sessionKey }
              : { sessionId: query.sessionId }),
          })
        : undefined;
    if (current) {
      return current.entry;
    }
    const currentPrepared = preparedReads.getStore() ?? preparedEntries;
    preparedEntries = currentPrepared;
    if (currentPrepared?.has(readKey(query))) {
      return currentPrepared.get(readKey(query))!();
    }
    const legacy = legacyReader.getStore();
    if (legacy) {
      return legacy(query);
    }
    throw new SessionCapabilityReadRequired(query);
  };
  return {
    scope: { storePath, agentId },
    get: (sessionKey) => {
      if (source && isIncognitoSessionKey(sessionKey)) {
        return readActorEntry(sessionKey);
      }
      if (isInternalSessionEffectsKey(sessionKey)) {
        return undefined;
      }
      return entries.has(sessionKey)
        ? entries.get(sessionKey)
        : readDurable({ ...readScope, sessionKey });
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
      return readDurable({ ...readScope, sessionId: id });
    },
  };
}
