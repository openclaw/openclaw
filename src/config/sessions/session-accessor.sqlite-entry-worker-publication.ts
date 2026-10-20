import { communicationEntryBinding } from "../../sessions/communication-admission.js";
import {
  sessionChanges,
  type SessionRowChange,
  type SessionRowFacts,
} from "../../sessions/session-row-changes.js";
import { createDeferredCore } from "../../shared/deferred.js";
import {
  retainConversationWorkerPublication,
  type ConversationPublication,
} from "./session-accessor.sqlite-conversation-publication.js";
import {
  pendingSessionEntryPublications,
  markSessionSharingAuthorityUnknown,
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
import {
  captureSessionEntryMaintenanceAgeChange,
  publishSessionEntryMaintenanceAgeChanges,
} from "./session-accessor.sqlite-maintenance-age.js";
import {
  publishRetainedSessionEntryPredicate,
  publishRetainedSessionGeneration,
  revokePreparedSessionEntryPredicate,
  recordAcquiringSessionEntry,
} from "./session-accessor.sqlite-sharing-acquisition.js";
import type { SessionEntryMetadataReceipt } from "./session-entry-metadata-receipt.js";
import { retainSessionTranscriptWorkerPublication } from "./session-transcript-authority.js";
import type { SessionTranscriptAuthorityReceipt } from "./session-transcript-authority.types.js";
import type { SessionEntry } from "./types.js";

/** Publish confirmed removals or invalidate incomplete row facts without a parent connection. */
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
    const removed = params.removedSessionKeys?.has(sessionKey) === true;
    // Confirmed absence revokes a generation; other incomplete postimages remain unavailable.
    publishRetainedSessionEntryChange(
      params.databaseIdentity,
      sessionKey,
      undefined,
      undefined,
      removed,
    );
    const change: SessionRowChange = {
      agentId: params.agentId,
      storePath: params.storePath,
      sessionKey,
      ...(removed ? { facts: { kind: "removed" as const } } : { factsInvalidated: true }),
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

/** Later metadata commits cannot certify membership or a generation changed by an older write. */
function retireSupersededSessionFacts(
  params: { agentId: string; storePath: string; databaseIdentity: string },
  owner: PendingSessionEntryPublication,
  generationUnchanged: ReadonlySet<string>,
  supersededKeys: Iterable<string> = owner.superseded,
): SessionRowChange[] {
  return [...supersededKeys].flatMap((sessionKey) => {
    const membershipChanged = owner.membershipInvalidated.has(sessionKey);
    const generationChanged = !generationUnchanged.has(sessionKey);
    for (const read of preparedSharingReads.get(`file:${params.databaseIdentity}\0${sessionKey}`) ??
      []) {
      if (membershipChanged) {
        read.facts = undefined;
        recordAcquiringSessionEntry(read.acquisition, undefined, undefined);
      }
      if (generationChanged) {
        publishRetainedSessionGeneration(read, undefined, false);
      }
    }
    // Stable policy facts do not make the superseded row's projection current.
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
    return [change];
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
  const conversation = retainConversationWorkerPublication(
    params.databaseIdentity,
    params.storePath,
  );
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
  let sharingAuthorityChanged = true;
  const publication = {
    begin(
      sessionKeys: readonly string[],
      membershipInvalidatedKeys: readonly string[],
      sharingUnchangedKeys: readonly string[] = [],
      generationUnchangedKeys: readonly string[] = [],
      transcriptPublication?: readonly SessionTranscriptAuthorityReceipt[],
      entryPostimages?: ReadonlyMap<string, SessionEntry>,
      conversationReceipts?: readonly ConversationPublication[],
    ) {
      if (pending) {
        return;
      }
      keys = [...new Set(sessionKeys)];
      transcript.begin(transcriptPublication);
      conversation.begin(conversationReceipts ?? []);
      owner.membershipInvalidated = new Set(membershipInvalidatedKeys);
      owner.sharingUnchanged = new Set(sharingUnchangedKeys);
      owner.generationUnchanged = new Set(generationUnchangedKeys);
      owner.entryPostimages = entryPostimages;
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
      participantProjections?: PendingSessionEntryPublication["participantProjections"],
      entryPostimages?: ReadonlyMap<string, SessionEntry>,
      authorityChanged = true,
    ): void {
      if (pending) {
        return;
      }
      owner.participantProjections = participantProjections;
      sharingAuthorityChanged = authorityChanged;
      publication.begin(
        sessionKeys,
        [...memberships.keys()],
        [...(participantProjections?.keys() ?? [])],
        generationUnchangedKeys,
        undefined,
        entryPostimages,
      );
    },
    settleChanges<T>(
      changes: readonly SessionRowChange[],
      install: (
        currentKeys: ReadonlySet<string>,
        invalidations: readonly SessionRowChange[],
        release: () => void,
      ) => T,
    ): T {
      const current = new Set(
        changes.flatMap((change) =>
          "sessionKey" in change && !owner.superseded.has(change.sessionKey)
            ? [change.sessionKey]
            : [],
        ),
      );
      const invalidations = retireSupersededSessionFacts(params, owner, owner.generationUnchanged);
      return install(current, invalidations, () => {
        // Installing this receipt uses the native publisher, which also marks its own
        // pending owner superseded. Those postimages are already authoritative.
        for (const sessionKey of current) {
          owner.superseded.delete(sessionKey);
        }
        publication.settle(undefined, false);
      });
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
      publication.settleChanges(changes, (currentKeys, invalidations, release) => {
        const selected: SessionRowChange[] = [];
        for (const [index, record] of records.entries()) {
          if (record.receipt.source.identity !== params.databaseIdentity) {
            continue;
          }
          if (!currentKeys.has(record.sessionKey)) {
            for (const read of preparedSharingReads.get(`${identityKey}\0${record.sessionKey}`) ??
              []) {
              publishRetainedSessionEntryPredicate(read, record.value.entry, true, {
                preserveMatchingEntry: true,
              });
            }
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
        release();
        publishSessionEntryMaintenanceAgeChanges(
          params.databaseIdentity,
          identityRecords.flatMap(({ sessionKey, value }) =>
            value.previous
              ? []
              : [captureSessionEntryMaintenanceAgeChange({ sessionKey, entry: value.entry })],
          ),
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
        conversation.settle(receipt?.conversationPublication, outcomeUnknown);
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
      } else if (replacement) {
        // Lost completion delivery does not erase this owner's acknowledged COMMIT facts.
        unknown = false;
      }
      conversation.settle(unknown ? undefined : receipt?.conversationPublication, unknown);
      if (unknown && sharingAuthorityChanged) {
        for (const sessionKey of keys) {
          markSessionSharingAuthorityUnknown(params.databaseIdentity, sessionKey);
        }
      }
      const committedTranscriptChanges = [
        ...transcriptChanges,
        ...transcript.settle(Boolean(receipt), unknown, receipt?.transcriptPublication),
      ];
      const initialization =
        receipt?.kind === "session-transcript-initialized" ? receipt : undefined;
      const current = (sessionKey: string) => !owner.superseded.has(sessionKey);
      const known = !unknown && replacement !== undefined;
      // Member-only successors cannot certify policy; matching old facts must retain newer metadata.
      if (known || unknown) {
        for (const sessionKey of owner.superseded) {
          for (const read of preparedSharingReads.get(`${identityKey}\0${sessionKey}`) ?? []) {
            publishRetainedSessionEntryPredicate(
              read,
              replacement?.current.get(sessionKey),
              known,
              {
                preserveMatchingEntry: true,
              },
            );
          }
        }
      }
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
      const generationUnchanged = new Set(
        replacement?.generationUnchangedKeys ?? owner.generationUnchanged,
      );
      const superseded = retireSupersededSessionFacts(
        params,
        owner,
        generationUnchanged,
        [...owner.superseded].filter((sessionKey) => !changed.includes(sessionKey)),
      );
      if (changed.length || superseded.length) {
        invalidateSessionEntryCaches(params.databaseIdentity);
      }
      const changes: SessionRowChange[] = [];
      const sharingUnchanged = new Set(replacement?.sharingUnchangedKeys);
      const { prepared, currentMetadata, readCurrent } = prepareSessionEntryPublicationFacts({
        replacement,
        owner,
        databaseIdentity: params.databaseIdentity,
        unknown,
      });
      for (const sessionKey of changed) {
        const entry = replacement?.current.get(sessionKey);
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
            return {
              kind: "removed",
              ...(replacement.transcriptInventoryUnchanged
                ? { transcriptInventoryUnchanged: true }
                : {}),
            };
          }
          const currentEntry = readCurrent(sessionKey);
          return currentEntry?.projection
            ? {
                kind: "replacement",
                membership: currentEntry.projection.membership,
                communicationBinding: communicationEntryBinding(currentEntry.entry),
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
      changes.push(...superseded);
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
