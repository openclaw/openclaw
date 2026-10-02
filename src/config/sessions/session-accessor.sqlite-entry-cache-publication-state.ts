import { resolveGlobalSingleton } from "../../shared/global-singleton.js";
import { findOpenClawAgentDatabaseIdentity } from "../../state/openclaw-agent-db-identity.js";
import type {
  PendingSessionEntryPublication,
  SessionEntryCacheDatabase,
  SessionSharingEntry,
} from "./session-accessor.sqlite-entry-cache.types.js";
import {
  reconcileSessionSharingAcquisition,
  type CommittedSessionSharingFacts,
  type PreparedSessionSharingRead,
  type SessionSharingRetentionRequest,
} from "./session-accessor.sqlite-sharing-acquisition.js";
import type { SessionEntry } from "./types.js";

export const preparedSharingReads = resolveGlobalSingleton(
  Symbol.for("openclaw.preparedSessionSharingReads"),
  () => new Map<string, Set<PreparedSessionSharingRead>>(),
);
export const pendingSessionEntryPublications = resolveGlobalSingleton(
  Symbol.for("openclaw.pendingSessionEntryPublications"),
  () => new Map<string, Set<PendingSessionEntryPublication>>(),
);

export function recordCommittedSessionEntryPublication(
  database: SessionEntryCacheDatabase | string,
  sessionKey: string,
  entry: Pick<SessionEntry, "sessionId" | "lifecycleRevision"> | undefined,
): void {
  const identity =
    typeof database === "string" ? database : findOpenClawAgentDatabaseIdentity(database)?.identity;
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

export function recordCommittedSessionMetadataPublication(
  database: SessionEntryCacheDatabase,
  sessionKey: string,
): void {
  const identity = findOpenClawAgentDatabaseIdentity(database)?.identity;
  if (typeof identity === "string") {
    for (const pending of pendingSessionEntryPublications.get(`file:${identity}\0${sessionKey}`) ??
      []) {
      pending.metadataSuperseded.add(sessionKey);
    }
  }
}

/** The existing entry writer advances retained facts before any commit observer can reenter. */
export function retainPreparedSessionSharingFacts(params: SessionSharingRetentionRequest) {
  const key = `${params.databaseIdentity}\0${params.sessionKey}`;
  const initial = "acquiring" in params ? undefined : params;
  const read: PreparedSessionSharingRead = {
    pending: new Set(),
    facts: initial && {
      entry: initial.entry,
      placeholder: initial.placeholder,
      membership: initial.membership,
    },
    generation: initial?.generation,
    acquisition: initial ? undefined : { invalidated: false, membership: new Map() },
  };
  const reads = preparedSharingReads.get(key) ?? new Set<PreparedSessionSharingRead>();
  reads.add(read);
  preparedSharingReads.set(key, reads);
  let active = true;
  const pending = (membership: boolean) =>
    read.pending.size > 0 ||
    [...(pendingSessionEntryPublications.get(key) ?? [])].some(
      (publication) =>
        !publication.settled &&
        ((!publication.superseded.has(params.sessionKey) &&
          (!membership || !publication.sharingUnchanged.has(params.sessionKey))) ||
          (membership && publication.membershipInvalidated.has(params.sessionKey))),
    );
  return {
    initialize: (snapshot: CommittedSessionSharingFacts) => {
      const acquisition = read.acquisition;
      if (!active || !acquisition) {
        throw new Error("Session sharing acquisition is no longer current");
      }
      read.facts = reconcileSessionSharingAcquisition(acquisition, snapshot);
      read.acquisition = undefined;
    },
    readGeneration: () => (active && !pending(false) ? read.generation?.current : undefined),
    readCurrent: () => (pending(true) ? undefined : read.facts),
    release: () => {
      if (!active) {
        return;
      }
      active = false;
      read.facts = undefined;
      read.acquisition = undefined;
      reads.delete(read);
      if (reads.size === 0 && preparedSharingReads.get(key) === reads) {
        preparedSharingReads.delete(key);
      }
    },
  };
}

/** Generation custody shares the entry publication owner, independently of membership. */
export function retainPreparedSessionGenerationFacts(params: {
  databaseIdentity: string;
  sessionKey: string;
  entry: SessionSharingEntry | undefined;
}) {
  const retained = retainPreparedSessionSharingFacts({
    ...params,
    membership: new Set(),
    generation: { current: params.entry ?? null, initiallyAbsent: params.entry ? undefined : true },
  });
  return { readCurrent: retained.readGeneration, release: retained.release };
}

export function retainedSharingReads(
  database: SessionEntryCacheDatabase | string,
  sessionKey: string,
) {
  const identity =
    typeof database === "string" ? database : findOpenClawAgentDatabaseIdentity(database)?.identity;
  return typeof identity === "string"
    ? preparedSharingReads.get(`file:${identity}\0${sessionKey}`)
    : undefined;
}
