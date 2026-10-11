import {
  sessionChanges,
  type SessionRowChange,
  type SessionRowFacts,
} from "../../sessions/session-row-changes.js";
import { readSessionTranscriptUpdateVersion } from "../../sessions/transcript-events.js";
import { createDeferredCore } from "../../shared/deferred.js";
import {
  pendingSessionEntryPublications,
  prepareSessionEntryPublicationFacts,
  preparedSharingReads,
  publishRetainedSessionEntryChange,
  recordCommittedSessionMetadataPublication,
  readCurrentSessionEntryProjection,
  recordCommittedSessionEntryPublication,
  preparedSharingChanges,
} from "./session-accessor.sqlite-entry-cache-publication-state.js";
import {
  bindPreparedSessionEntryPublication,
  invalidateSessionEntryCaches,
} from "./session-accessor.sqlite-entry-cache-publication.js";
import {
  projectSessionSharingEntry,
  type PendingSessionEntryPublication,
  type SessionEntryReplacementPublication,
  type SessionTranscriptInitializationPublication,
} from "./session-accessor.sqlite-entry-cache.types.js";
import { isSessionEntryReplacementReceiptUsable } from "./session-accessor.sqlite-entry-receipt.js";
import { publishSessionEntryMaintenanceAgeChanges } from "./session-accessor.sqlite-maintenance-age.js";
import {
  publishRetainedSessionEntryPredicate,
  publishRetainedSessionGeneration,
  revokePreparedSessionEntryPredicate,
  recordAcquiringSessionEntry,
} from "./session-accessor.sqlite-sharing-acquisition.js";
import type { SessionEntryMetadataReceipt } from "./session-entry-metadata-receipt.js";
import {
  retainSessionTranscriptWorkerPublication,
  type SessionTranscriptAuthorityReceipt,
} from "./session-transcript-authority.js";
import type { SessionEntry } from "./types.js";

/** A confirmed worker result invalidates row facts without opening a parent connection. */
export function publishSessionEntryWorkerInvalidations(
  params: {
    agentId: string;
    storePath: string;
    databaseIdentity: string;
    removedSessionKeys?: ReadonlySet<string>;
  },
  changedKeys: readonly string[],
  beforePublicNotifications?: () => void,
): void {
  const keys = [...new Set(changedKeys)];
  const changes: SessionRowChange[] = [];
  for (const sessionKey of keys) {
    // Confirmed absence revokes a generation; other incomplete postimages remain unavailable.
    publishRetainedSessionEntryChange(
      params.databaseIdentity,
      sessionKey,
      undefined,
      undefined,
      params.removedSessionKeys?.has(sessionKey) === true,
    );
    const change: SessionRowChange = {
      agentId: params.agentId,
      storePath: params.storePath,
      sessionKey,
      factsInvalidated: true,
    };
    bindPreparedSessionEntryPublication(change, {
      kind: "marker",
      sharingChange: "changed",
      databaseIdentity: params.databaseIdentity,
    });
    changes.push(change);
  }
  if (keys.length > 0) {
    invalidateSessionEntryCaches(params.databaseIdentity);
  }
  sessionChanges.emitBatch(changes, undefined, beforePublicNotifications);
}

/** A superseded receipt is discarded wholesale; the next read refreshes its facts. */
function retireSessionEntryMembership(
  params: { agentId: string; storePath: string; databaseIdentity: string },
  keys: readonly string[],
): SessionRowChange[] {
  return [...new Set(keys)].map((sessionKey) => {
    for (const read of preparedSharingReads.get(`file:${params.databaseIdentity}\0${sessionKey}`) ??
      []) {
      read.facts = undefined;
      recordAcquiringSessionEntry(read.acquisition, undefined, undefined);
      publishRetainedSessionEntryPredicate(read, undefined, false);
      publishRetainedSessionGeneration(read, undefined, false);
    }
    const change: SessionRowChange = {
      agentId: params.agentId,
      storePath: params.storePath,
      sessionKey,
      scope: "session-entry",
      factsInvalidated: true,
    };
    bindPreparedSessionEntryPublication(change, {
      kind: "marker",
      sharingChange: "unchanged",
      databaseIdentity: params.databaseIdentity,
    });
    return change;
  });
}

/** Final-grant custody fences old facts until native settlement, independently of result delivery. */
export function retainSessionEntryWorkerPublication(params: {
  agentId: string;
  storePath: string;
  databaseIdentity: string;
}) {
  const creation = preparedSharingChanges.current.getStore();
  const transcript = retainSessionTranscriptWorkerPublication(params);
  const completion = createDeferredCore();
  const owner: PendingSessionEntryPublication = {
    superseded: new Set(),
    membershipInvalidated: new Set(),
    sharingUnchanged: new Set(),
    generationUnchanged: new Set(),
    settled: false,
    completion: completion.promise,
  };
  let keys: string[] = [];
  const identityKey = `file:${params.databaseIdentity}`;
  let pending = false;
  let transcriptVersion: number | undefined;
  const publication = {
    begin(
      sessionKeys: readonly string[],
      membershipInvalidatedKeys: readonly string[],
      sharingUnchangedKeys: readonly string[] = [],
      generationUnchangedKeys: readonly string[] = [],
      transcriptPublication?: readonly SessionTranscriptAuthorityReceipt[],
    ) {
      if (pending) {
        return;
      }
      keys = [...new Set(sessionKeys)];
      transcriptVersion = readSessionTranscriptUpdateVersion();
      transcript.begin(transcriptPublication);
      owner.membershipInvalidated = new Set(membershipInvalidatedKeys);
      owner.sharingUnchanged = new Set(sharingUnchangedKeys);
      owner.generationUnchanged = new Set(generationUnchangedKeys);
      pending = true;
      for (const sessionKey of keys) {
        const key = `${identityKey}\0${sessionKey}`;
        const owners = pendingSessionEntryPublications.get(key) ?? new Set();
        owners.add(owner);
        pendingSessionEntryPublications.set(key, owners);
      }
    },
    /** Delta writers share the entry owner's pending custody and supersession. */
    beginChanges(
      sessionKeys: readonly string[],
      memberships: ReadonlyMap<string, string> = new Map(),
      generationUnchangedKeys: readonly string[] = sessionKeys,
    ): void {
      if (pending) {
        return;
      }
      publication.begin(sessionKeys, [...memberships.keys()], [], generationUnchangedKeys);
    },
    settleChanges<T>(
      changes: readonly SessionRowChange[],
      install: (currentKeys: ReadonlySet<string>, invalidations: readonly SessionRowChange[]) => T,
    ): T {
      const current = new Set(
        changes.flatMap((change) =>
          "sessionKey" in change && !owner.superseded.has(change.sessionKey)
            ? [change.sessionKey]
            : [],
        ),
      );
      const invalidations = retireSessionEntryMembership(params, [...owner.superseded]);
      publication.settle(undefined, false);
      return install(current, invalidations);
    },
    /** Metadata workers replay the same entry delta that the native producer committed. */
    settleMetadata(
      receipts: readonly SessionEntryMetadataReceipt[],
      transcriptChanges: readonly SessionRowChange[],
      publishIdentity: (
        previous: ReadonlyMap<string, Pick<SessionEntry, "sessionId" | "lifecycleRevision">>,
        current: ReadonlyMap<string, Pick<SessionEntry, "sessionId" | "lifecycleRevision">>,
      ) => void,
    ): void {
      const records = receipts.flatMap((receipt) =>
        [...receipt.facts].flatMap(([sessionKey, fact]) =>
          fact.kind === "postimage" ? [{ receipt, sessionKey, value: fact.value }] : [],
        ),
      );
      const changes: SessionRowChange[] = records.map(({ sessionKey, value }) => ({
        agentId: params.agentId,
        storePath: params.storePath,
        sessionKey,
        scope: "session-entry",
        facts: value.facts,
      }));
      publication.settleChanges(changes, (currentKeys, invalidations) => {
        const selected: SessionRowChange[] = [];
        for (const [index, record] of records.entries()) {
          if (record.receipt.source.identity !== params.databaseIdentity) {
            continue;
          }
          if (!currentKeys.has(record.sessionKey)) {
            continue;
          }
          const entry = record.value.entry;
          const facts = { ...record.value.facts, category: entry.category?.trim() || null };
          const { sharingChange } = record.value;
          if (sharingChange === "unchanged") {
            recordCommittedSessionMetadataPublication(
              params.databaseIdentity,
              record.sessionKey,
              facts,
              entry,
            );
          } else {
            publishRetainedSessionEntryChange(
              params.databaseIdentity,
              record.sessionKey,
              projectSessionSharingEntry(entry),
              facts.previousSessionId && !facts.lifecycleChanged
                ? { sessionId: facts.previousSessionId, lifecycleRevision: entry.lifecycleRevision }
                : undefined,
              true,
              entry,
            );
          }
          const change = { ...changes[index]!, facts };
          bindPreparedSessionEntryPublication(change, {
            kind: "metadata",
            sharingChange,
            prepared: {
              source: record.receipt.source,
              entries: new Map([[record.sessionKey, entry]]),
              ...(record.value.fullEntry
                ? { fullEntries: new Map([[record.sessionKey, record.value.fullEntry]]) }
                : {}),
            },
          });
          selected.push(change);
        }
        if (selected.length) {
          invalidateSessionEntryCaches(params.databaseIdentity);
        }
        const identityRecords = records.filter(
          ({ receipt, sessionKey }) =>
            receipt.source.identity === params.databaseIdentity && currentKeys.has(sessionKey),
        );
        sessionChanges.emitBatch(
          [...selected, ...invalidations, ...transcriptChanges],
          undefined,
          identityRecords.length
            ? () => {
                publishIdentity(
                  new Map(
                    identityRecords.flatMap(({ sessionKey, value }) =>
                      value.previous ? [[sessionKey, value.previous] as const] : [],
                    ),
                  ),
                  new Map(
                    identityRecords.map(({ sessionKey, value }) => [sessionKey, value.entry]),
                  ),
                );
              }
            : undefined,
        );
      });
    },
    settle(
      receipt:
        | SessionEntryReplacementPublication
        | SessionTranscriptInitializationPublication
        | undefined,
      outcomeUnknown: boolean,
      transcriptChanges: readonly SessionRowChange[] = [],
    ) {
      if (!pending) {
        sessionChanges.emitBatch([
          ...transcriptChanges,
          ...transcript.settle(Boolean(receipt), outcomeUnknown, receipt?.transcriptPublication),
        ]);
        return undefined;
      }
      let unknown = outcomeUnknown;
      let replacement = receipt?.kind === "session-entry-replacements" ? receipt : undefined;
      if (
        replacement &&
        !isSessionEntryReplacementReceiptUsable(replacement, keys, params.databaseIdentity)
      ) {
        replacement = undefined;
        unknown = true;
      }
      const committedTranscriptChanges = [
        ...transcriptChanges,
        ...transcript.settle(Boolean(receipt), unknown, receipt?.transcriptPublication),
      ];
      const initialization =
        receipt?.kind === "session-transcript-initialized" ? receipt : undefined;
      const current = (sessionKey: string) => !owner.superseded.has(sessionKey);
      const known = !unknown && replacement !== undefined;
      // A later native metadata write cannot restore membership omitted by an alias move.
      const membershipInvalidated = new Set(
        replacement
          ? replacement.membershipInvalidatedKeys.filter(current)
          : unknown
            ? owner.membershipInvalidated
            : [],
      );
      const changed = [
        ...new Set([
          ...(
            replacement?.changedKeys ??
            (initialization?.placeholder ? [initialization.sessionKey] : unknown ? keys : [])
          ).filter(current),
          ...membershipInvalidated,
        ]),
      ];
      const supersededMembership = [...owner.superseded].filter((key) => !changed.includes(key));
      if (changed.length || supersededMembership.length) {
        invalidateSessionEntryCaches(params.databaseIdentity);
      }
      const changes: SessionRowChange[] = [];
      const sharingUnchanged = new Set(replacement?.sharingUnchangedKeys);
      const generationUnchanged = new Set(replacement?.generationUnchangedKeys);
      const { prepared, currentMetadata, readCurrent } = prepareSessionEntryPublicationFacts({
        replacement,
        owner,
        databaseIdentity: params.databaseIdentity,
        unknown,
        transcriptVersion,
      });
      for (const sessionKey of changed) {
        const entry = replacement?.current.get(sessionKey);
        // A later transcript append retires its display watermark, not committed sharing facts.
        const sharingProjection =
          prepared && readCurrentSessionEntryProjection(owner, replacement, sessionKey);
        const sharingEntry = entry ? projectSessionSharingEntry(entry) : undefined;
        const placeholder =
          initialization?.sessionKey === sessionKey ? initialization.placeholder : undefined;
        const creationSource = creation?.source;
        const ownsCreation =
          creation?.active &&
          creationSource?.kind === "file" &&
          creationSource.databaseIdentity === params.databaseIdentity &&
          creationSource.agentId === params.agentId &&
          creation.sessionKey === sessionKey;
        for (const read of preparedSharingReads.get(`${identityKey}\0${sessionKey}`) ?? []) {
          if (placeholder) {
            revokePreparedSessionEntryPredicate(read);
          } else if (current(sessionKey)) {
            publishRetainedSessionEntryPredicate(
              read,
              entry,
              known && !replacement?.unavailableParticipantKeys?.includes(sessionKey),
            );
          }
          recordAcquiringSessionEntry(
            read.acquisition,
            sharingProjection ? sharingEntry : undefined,
            replacement?.previous.get(sessionKey),
          );
          publishRetainedSessionGeneration(
            read,
            sharingEntry,
            known || (!unknown && placeholder !== undefined),
          );
          const previous = read.facts;
          read.facts =
            !unknown && placeholder
              ? { entry: undefined, placeholder, membership: new Set() }
              : !unknown &&
                  sharingProjection &&
                  sharingEntry &&
                  previous?.entry &&
                  previous.entry.sessionId === sharingEntry.sessionId &&
                  previous.entry.lifecycleRevision === sharingEntry.lifecycleRevision
                ? {
                    entry: sharingEntry,
                    membership: new Set(sharingProjection.membership[2]),
                  }
                : undefined;
        }
        // Synchronous listeners can publish newer facts before the next listener consumes this one.
        const currentFacts = (): SessionRowFacts | undefined => {
          if (!known || !currentMetadata(sessionKey)) {
            return undefined;
          }
          if (replacement?.previous.has(sessionKey) && !replacement.current.has(sessionKey)) {
            return { kind: "removed" };
          }
          const currentProjection = readCurrent(sessionKey)?.projection;
          return currentProjection
            ? {
                kind: "replacement",
                membership: currentProjection.membership,
                lifecycleChanged: !generationUnchanged.has(sessionKey),
              }
            : undefined;
        };
        const change: SessionRowChange = {
          agentId: params.agentId,
          storePath: ownsCreation ? creationSource.path : params.storePath,
          sessionKey,
          get facts() {
            return currentFacts();
          },
          get factsInvalidated() {
            return currentFacts() ? undefined : true;
          },
          ...(receipt && !unknown ? { scope: "session-entry" as const } : {}),
        };
        if (receipt) {
          // A COMMIT receipt can survive unknown settlement without retaining creation custody.
          const sharingChange =
            !membershipInvalidated.has(sessionKey) && sharingUnchanged.has(sessionKey)
              ? "unchanged"
              : "changed";
          bindPreparedSessionEntryPublication(
            change,
            !unknown && placeholder && ownsCreation
              ? {
                  kind: "placeholder",
                  sharingChange: "changed",
                  databaseIdentity: params.databaseIdentity,
                  receipt: {
                    kind: "placeholder",
                    creation,
                    databaseIdentity: params.databaseIdentity,
                    sessionKey,
                    placeholder,
                    committed: true,
                  },
                }
              : prepared &&
                  (replacement?.previous.has(sessionKey) || replacement?.current.has(sessionKey))
                ? {
                    kind: "metadata",
                    sharingChange,
                    prepared,
                    readCurrent,
                    ...(known &&
                    ownsCreation &&
                    current(sessionKey) &&
                    sharingEntry &&
                    !replacement?.previous.has(sessionKey)
                      ? {
                          creation: {
                            kind: "entry" as const,
                            creation,
                            databaseIdentity: params.databaseIdentity,
                            sessionKey,
                            entry: sharingEntry,
                            committed: true as const,
                          },
                        }
                      : {}),
                  }
                : { kind: "marker", sharingChange, databaseIdentity: params.databaseIdentity },
          );
        } else {
          bindPreparedSessionEntryPublication(change, {
            kind: "source",
            databaseIdentity: params.databaseIdentity,
          });
        }
        changes.push(change);
      }
      changes.push(...retireSessionEntryMembership(params, supersededMembership));
      // Unknown successors also retire older facts; a late receipt cannot resolve their outcome.
      for (const sessionKey of changed) {
        recordCommittedSessionEntryPublication(params.databaseIdentity, sessionKey, owner);
      }
      owner.settled = true;
      try {
        if (replacement) {
          publishSessionEntryMaintenanceAgeChanges(
            params.databaseIdentity,
            replacement.ageChanges.filter(({ sessionKey }) => known && current(sessionKey)),
          );
        }
        sessionChanges.emitBatch([...changes, ...committedTranscriptChanges]);
        // Unknown settlement fences retained facts, not an acknowledged identity mutation.
        return replacement
          ? {
              previous: new Map([...replacement.previous].filter(([key]) => current(key))),
              current: new Map([...replacement.current].filter(([key]) => current(key))),
              prepared,
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
        completion.resolve();
      }
    },
  };
  return publication;
}
