import type { SessionRowFacts } from "../../sessions/session-row-changes.js";
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";
import { freezeJsonSnapshot } from "../../shared/immutable-data.js";
import { findOpenClawAgentDatabaseIdentity } from "../../state/openclaw-agent-db-identity.js";
import type {
  PendingSessionEntryPublication,
  SessionEntryCacheDatabase,
  SessionEntryReplacementPublication,
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

export function recordCommittedSessionOwnerPublication(
  database: SessionEntryCacheDatabase,
  sessionKey: string,
  change: Extract<SessionRowFacts, { kind: "owner" }>,
): void {
  const identity = findOpenClawAgentDatabaseIdentity(database)?.identity;
  if (typeof identity === "string") {
    for (const pending of pendingSessionEntryPublications.get(`file:${identity}\0${sessionKey}`) ??
      []) {
      // A field update supersedes its value, not the pending entry's generation fence.
      pending.ownerChanges.set(sessionKey, structuredClone(change));
    }
  }
}

export function applyPendingSessionEntryOwnerChanges(
  replacement: SessionEntryReplacementPublication | undefined,
  ownerChanges: PendingSessionEntryPublication["ownerChanges"],
): SessionEntryReplacementPublication | undefined {
  if (!replacement || ownerChanges.size === 0) {
    return replacement;
  }
  const current = new Map(replacement.current);
  for (const [sessionKey, change] of ownerChanges) {
    const entry = current.get(sessionKey);
    if (
      !entry ||
      entry.sessionId !== change.sessionId ||
      (entry.lifecycleRevision ?? null) !== change.lifecycleRevision
    ) {
      continue;
    }
    const { owner: _previousOwner, ...metadata } = entry;
    current.set(
      sessionKey,
      freezeJsonSnapshot({ ...metadata, ...(change.owner ? { owner: change.owner } : {}) }),
    );
  }
  return { ...replacement, current };
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
    prepareRead: (): Promise<void> | undefined => {
      // Publication begins only after writer admission; queued writers cannot block their owner.
      const completions = [...(pendingSessionEntryPublications.get(key) ?? [])].flatMap(
        (publication) =>
          !publication.settled && !publication.superseded.has(params.sessionKey)
            ? [publication.completion]
            : [],
      );
      return completions.length > 0 ? Promise.all(completions).then(() => {}) : undefined;
    },
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
  return {
    readCurrent: retained.readGeneration,
    prepareRead: retained.prepareRead,
    release: retained.release,
  };
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
