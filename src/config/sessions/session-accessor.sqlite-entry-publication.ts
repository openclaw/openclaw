import type { DatabaseSync } from "node:sqlite";
import {
  sessionChanges,
  type SessionRowChange,
  type SessionRowFacts,
} from "../../sessions/session-row-changes.js";
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";
import { findOpenClawAgentDatabaseIdentity } from "../../state/openclaw-agent-db-identity.js";
import { invalidateOpenClawAgentWritableProjections } from "../../state/openclaw-agent-db-lifecycle.js";
import { invalidateOpenClawAgentReadOnlyProjections } from "../../state/openclaw-agent-db-readonly-scope.js";
import type { SessionEntryCacheDatabase } from "./session-accessor.sqlite-entry-cache-projection.js";
import type { SessionSharingEntry } from "./session-accessor.sqlite-entry-cache.types.js";
import type { SessionEntry } from "./types.js";

export type SessionEntryReplacementPublication = {
  kind: "session-entry-replacements";
  previous: Map<string, Pick<SessionEntry, "sessionId" | "lifecycleRevision">>;
  current: Map<string, SessionSharingEntry>;
  changedKeys: string[];
  membershipInvalidatedKeys: string[];
};

type PreparedSessionSharingRead = {
  facts: { entry: SessionSharingEntry | undefined; membership: ReadonlySet<string> } | undefined;
  generation?: {
    current: Pick<SessionEntry, "sessionId" | "lifecycleRevision"> | null | undefined;
  };
};
const preparedSharingReads = resolveGlobalSingleton(
  Symbol.for("openclaw.preparedSessionSharingReads"),
  () => new Map<string, Set<PreparedSessionSharingRead>>(),
);
const preparedSharingChanges = resolveGlobalSingleton(
  Symbol.for("openclaw.preparedSessionSharingChanges"),
  () => new WeakSet<SessionRowChange>(),
);

type PendingSessionEntryPublication = {
  superseded: Map<string, Pick<SessionEntry, "sessionId" | "lifecycleRevision"> | undefined>;
  membershipInvalidated: Set<string>;
  settled: boolean;
};
const pendingSessionEntryPublications = resolveGlobalSingleton(
  Symbol.for("openclaw.pendingSessionEntryPublications"),
  () => new Map<string, Set<PendingSessionEntryPublication>>(),
);

export function recordCommittedSessionEntryPublication(
  database: SessionEntryCacheDatabase,
  sessionKey: string,
  entry: SessionSharingEntry | undefined,
): void {
  const identity = findOpenClawAgentDatabaseIdentity(database)?.identity;
  if (typeof identity !== "string") {
    return;
  }
  for (const pending of pendingSessionEntryPublications.get(`file:${identity}\0${sessionKey}`) ??
    []) {
    pending.superseded.set(
      sessionKey,
      entry
        ? { sessionId: entry.sessionId, lifecycleRevision: entry.lifecycleRevision }
        : undefined,
    );
  }
}

/** Private owner metadata follows the original event object without changing its public fields. */
export function isPreparedSessionSharingChange(change: SessionRowChange): boolean {
  return preparedSharingChanges.has(change);
}

export function emitPreparedSessionSharingChange(
  database: SessionEntryCacheDatabase & { path: string },
  sessionKey: string,
  agentId = database.agentId,
  facts?: SessionRowFacts,
): void {
  const change: SessionRowChange = {
    agentId,
    storePath: database.path,
    sessionKey,
    ...(facts ? { facts } : { factsInvalidated: true }),
  };
  preparedSharingChanges.add(change);
  sessionChanges.emit(change, database.db);
}

export function projectSessionSharingEntry(entry: SessionEntry): SessionSharingEntry {
  return {
    sessionId: entry.sessionId,
    updatedAt: entry.updatedAt,
    lifecycleRevision: entry.lifecycleRevision,
    visibility: entry.visibility,
    incognito: entry.incognito,
    createdActor: entry.createdActor ? { ...entry.createdActor } : undefined,
    sandbox: entry.sandbox,
  };
}

/** The existing entry writer advances retained facts before any commit observer can reenter. */
export function retainPreparedSessionSharingFacts(params: {
  databaseIdentity: string;
  sessionKey: string;
  entry: SessionSharingEntry | undefined;
  membership: ReadonlySet<string>;
  generation?: PreparedSessionSharingRead["generation"];
}) {
  const key = `${params.databaseIdentity}\0${params.sessionKey}`;
  const read: PreparedSessionSharingRead = {
    facts: { entry: params.entry, membership: params.membership },
    generation: params.generation,
  };
  const reads = preparedSharingReads.get(key) ?? new Set<PreparedSessionSharingRead>();
  reads.add(read);
  preparedSharingReads.set(key, reads);
  let active = true;
  return {
    readGeneration: () =>
      [...(pendingSessionEntryPublications.get(key) ?? [])].some(
        (pending) => !pending.settled && !pending.superseded.has(params.sessionKey),
      )
        ? undefined
        : active
          ? read.generation?.current
          : undefined,
    readCurrent: () =>
      [...(pendingSessionEntryPublications.get(key) ?? [])].some(
        (pending) =>
          !pending.settled &&
          (!pending.superseded.has(params.sessionKey) ||
            pending.membershipInvalidated.has(params.sessionKey)),
      )
        ? undefined
        : read.facts,
    release: () => {
      if (!active) {
        return;
      }
      active = false;
      read.facts = undefined;
      reads.delete(read);
      if (reads.size === 0 && preparedSharingReads.get(key) === reads) {
        preparedSharingReads.delete(key);
      }
    },
  };
}

/** Generation custody shares the existing entry publication owner, independently of membership. */
export function retainPreparedSessionGenerationFacts(params: {
  databaseIdentity: string;
  sessionKey: string;
  entry: SessionSharingEntry | undefined;
}) {
  const retained = retainPreparedSessionSharingFacts({
    ...params,
    membership: new Set(),
    generation: { current: params.entry ?? null },
  });
  return { readCurrent: retained.readGeneration, release: retained.release };
}

export function publishRetainedSessionGeneration(
  read: PreparedSessionSharingRead,
  entry: SessionSharingEntry | undefined,
  known: boolean,
) {
  const generation = read.generation;
  if (!generation?.current) {
    return;
  }
  if (!known) {
    generation.current = undefined;
  } else if (
    !entry ||
    generation.current.sessionId !== entry.sessionId ||
    generation.current.lifecycleRevision !== entry.lifecycleRevision
  ) {
    generation.current = null;
  }
}

export function retainedSharingReads(database: SessionEntryCacheDatabase, sessionKey: string) {
  const identity = findOpenClawAgentDatabaseIdentity(database)?.identity;
  return typeof identity === "string"
    ? preparedSharingReads.get(`file:${identity}\0${sessionKey}`)
    : undefined;
}
/** Final-grant custody fences old facts until native settlement, independently of result delivery. */
export function retainSessionEntryWorkerPublicationCore(
  params: {
    agentId: string;
    storePath: string;
    databaseIdentity: string;
  },
  invalidateCache: (database: DatabaseSync) => void,
) {
  const owner: PendingSessionEntryPublication = {
    superseded: new Map(),
    membershipInvalidated: new Set(),
    settled: false,
  };
  let keys: string[] = [];
  const identityKey = `file:${params.databaseIdentity}`;
  let pending = false;
  return {
    begin(sessionKeys: readonly string[], membershipInvalidatedKeys: readonly string[]) {
      if (pending) {
        return;
      }
      keys = [...new Set(sessionKeys)];
      owner.membershipInvalidated = new Set(membershipInvalidatedKeys);
      pending = true;
      for (const sessionKey of keys) {
        const key = `${identityKey}\0${sessionKey}`;
        const owners = pendingSessionEntryPublications.get(key) ?? new Set();
        owners.add(owner);
        pendingSessionEntryPublications.set(key, owners);
      }
    },
    settle(receipt: SessionEntryReplacementPublication | undefined, unknown: boolean) {
      if (!pending) {
        return undefined;
      }
      const current = (sessionKey: string) => !owner.superseded.has(sessionKey);
      const currentIdentity = (sessionKey: string) => {
        if (current(sessionKey)) {
          return true;
        }
        const native = owner.superseded.get(sessionKey);
        const committed = receipt?.current.get(sessionKey);
        // A later metadata write supersedes sharing facts, but retains this lifecycle transition.
        return (
          native !== undefined &&
          committed !== undefined &&
          native.sessionId === committed.sessionId &&
          native.lifecycleRevision === committed.lifecycleRevision
        );
      };
      // A later native metadata write cannot restore membership omitted by an alias move.
      const membershipInvalidated = new Set(
        receipt
          ? receipt.membershipInvalidatedKeys.filter(currentIdentity)
          : unknown
            ? owner.membershipInvalidated
            : [],
      );
      const changed = [
        ...new Set([
          ...(receipt?.changedKeys ?? (unknown ? keys : [])).filter(current),
          ...membershipInvalidated,
        ]),
      ];
      if (changed.length) {
        invalidateOpenClawAgentWritableProjections(params.databaseIdentity, invalidateCache);
        invalidateOpenClawAgentReadOnlyProjections(params.databaseIdentity, invalidateCache);
      }
      const changes: SessionRowChange[] = [];
      for (const sessionKey of changed) {
        const sharingEntry = receipt?.current.get(sessionKey);
        for (const read of preparedSharingReads.get(`${identityKey}\0${sessionKey}`) ?? []) {
          publishRetainedSessionGeneration(read, sharingEntry, receipt !== undefined);
          const previous = read.facts;
          read.facts =
            !membershipInvalidated.has(sessionKey) &&
            sharingEntry &&
            previous?.entry &&
            previous.entry.sessionId === sharingEntry.sessionId &&
            previous.entry.lifecycleRevision === sharingEntry.lifecycleRevision
              ? { entry: sharingEntry, membership: previous.membership }
              : undefined;
        }
        const change: SessionRowChange = {
          agentId: params.agentId,
          storePath: params.storePath,
          sessionKey,
          factsInvalidated: true,
        };
        if (receipt) {
          preparedSharingChanges.add(change);
        }
        changes.push(change);
      }
      owner.settled = true;
      try {
        sessionChanges.emitBatch(changes);
        return receipt
          ? {
              previous: new Map([...receipt.previous].filter(([key]) => currentIdentity(key))),
              current: new Map([...receipt.current].filter(([key]) => currentIdentity(key))),
            }
          : undefined;
      } finally {
        for (const sessionKey of keys) {
          const key = `${identityKey}\0${sessionKey}`;
          const owners = pendingSessionEntryPublications.get(key);
          owners?.delete(owner);
          if (owners?.size === 0) {
            pendingSessionEntryPublications.delete(key);
          }
        }
        pending = false;
      }
    },
  };
}
