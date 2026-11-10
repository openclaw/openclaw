import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { getAdmittedSqlSchemaFacts } from "../../infra/sqlite-schema-facts.js";
import { freezeJsonSnapshot } from "../../shared/immutable-data.js";
import { readOpenClawAgentDatabaseIdentity } from "../../state/openclaw-agent-db-identity.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { readSessionActivitySummary } from "./activity-summary.js";
import { isInternalSessionEffectsKey } from "./internal-session-key.js";
import { readStagedConversationPublications } from "./session-accessor.sqlite-conversation-publication.js";
import {
  sessionSharingEntriesEqual,
  type SessionEntryProjectionFacts,
  type SessionEntryReplacementPublication,
} from "./session-accessor.sqlite-entry-cache.types.js";
import { sqliteSessionEntriesEqual } from "./session-accessor.sqlite-entry-equality.js";
import {
  prepareExactSessionEntryRowReads,
  type ResolvedSessionEntryRow,
} from "./session-accessor.sqlite-entry-read.js";
import { readSessionNodesGeneration } from "./session-accessor.sqlite-entry-revision.js";
import { captureSessionEntryMaintenanceAgeChange } from "./session-accessor.sqlite-maintenance-age.js";
import type { SessionEntryReplacementCommitted } from "./session-accessor.sqlite-replacement-types.js";
import { readSessionTranscriptWatermarkInDatabase } from "./session-accessor.sqlite-transcript-watermark.js";
import { readSessionActorTransactionState } from "./session-actor-transaction.js";
import {
  captureSessionEntryPublicationSource,
  discardSessionEntryPublicationSource,
  hasSessionEntryPublicationCapacity,
} from "./session-entry-publication-source.js";
import { attachSessionEntrySnapshots } from "./session-entry-snapshot-values.js";
import type { SessionEntryWritePostimages } from "./session-entry-write-postimage.js";
import { readStagedSessionTranscriptAuthority } from "./session-transcript-authority.js";
import type { SessionEntry } from "./types.js";

/** Display metadata and bounded full-entry facts share the writer's final persisted read. */
export function prepareSessionEntryReplacementPublication(
  result: SessionEntryReplacementCommitted,
  database: OpenClawAgentDatabase,
  options?: { captureFullFacts?: boolean; postimages?: SessionEntryWritePostimages },
): SessionEntryReplacementPublication {
  const archived = new Set(
    result.maintenancePlans.flatMap((plan) =>
      plan.archivedEntries.map(({ sessionKey }) => sessionKey),
    ),
  );
  const invalidated = new Set([...result.membershipInvalidatedKeys, ...archived]);
  const current = new Map<string, SessionEntry>();
  const fullEntries = options?.captureFullFacts ? new Map<string, SessionEntry>() : undefined;
  const projection = new Map<string, SessionEntryProjectionFacts>();
  const unavailableParticipantKeys = new Set<string>();
  let readCommitted: ReturnType<typeof prepareExactSessionEntryRowReads> | undefined;
  for (const key of result.current.keys()) {
    const postimage = options?.postimages?.get(key);
    let committed: ResolvedSessionEntryRow | undefined;
    if (!postimage) {
      // Owners without a complete write receipt still acquire their final projection here.
      readCommitted ??= prepareExactSessionEntryRowReads(
        database,
        [...result.current.keys()].filter((currentKey) => !options?.postimages?.has(currentKey)),
        fullEntries ? "full" : "list",
        undefined,
        {
          includeBoardPresence: true,
          includeMembership: true,
          onParticipantProjectionError: (sessionKey) => unavailableParticipantKeys.add(sessionKey),
        },
      );
      committed = readCommitted(key);
    }
    const memberIds: unknown = JSON.parse(
      postimage?.sideTables.memberIdsJson ?? committed?.row.member_ids_json ?? "null",
    );
    if (
      !Array.isArray(memberIds) ||
      !memberIds.every((id): id is string => typeof id === "string")
    ) {
      throw new Error(`Session publication lost its committed membership: ${key}`);
    }
    const committedEntry = postimage?.entry ?? committed?.entry;
    if (!committedEntry) {
      throw new Error(`Session publication lost its committed metadata: ${key}`);
    }
    const entry = freezeJsonSnapshot(
      attachSessionEntrySnapshots({ ...committedEntry }, {}, "list"),
    );
    current.set(key, entry);
    if (unavailableParticipantKeys.has(key)) {
      continue;
    }
    fullEntries?.set(key, freezeJsonSnapshot(committedEntry));
    const projectedEntry = committedEntry;
    projection.set(
      key,
      freezeJsonSnapshot({
        membership: [
          key,
          isInternalSessionEffectsKey(key)
            ? null
            : (normalizeOptionalString(projectedEntry.category) ?? null),
          memberIds,
          {
            ...(projectedEntry.participants ? { participants: projectedEntry.participants } : {}),
            ...(projectedEntry.participantCount === undefined
              ? {}
              : { participantCount: projectedEntry.participantCount }),
          },
          projectedEntry.sessionId,
        ],
        hasBoard: postimage?.sideTables.hasBoard ?? committed?.row.board_present === 1,
        activitySummaryWatermark: readSessionActivitySummary(projectedEntry)
          ? (postimage?.transcriptWatermark ??
            readSessionTranscriptWatermarkInDatabase(database, projectedEntry.sessionId))
          : undefined,
      }),
    );
  }
  const source = getAdmittedSqlSchemaFacts(database.db)
    ? captureSessionEntryPublicationSource(database.db, {
        ...readOpenClawAgentDatabaseIdentity(database),
        // Actor receipts carry the complete postimage at the native writer revision.
        ...(!readSessionActorTransactionState(database)
          ? { revision: readSessionNodesGeneration(database.db) }
          : {}),
      })
    : undefined;
  const changedKeys = [
    ...new Set([...result.previous.keys(), ...result.current.keys(), ...archived]),
  ].filter(
    (key) =>
      invalidated.has(key) ||
      options?.postimages?.get(key)?.changed !== false ||
      // A final no-op must not hide an earlier replacement of the same key.
      !sqliteSessionEntriesEqual(result.previous.get(key), result.current.get(key)),
  );
  const publication: SessionEntryReplacementPublication = {
    kind: "session-entry-replacements",
    ...(result.patchDiffBaselines ? { patchDiffBaselines: result.patchDiffBaselines } : {}),
    conversationPublication: readStagedConversationPublications(database),
    transcriptPublication: readStagedSessionTranscriptAuthority(database),
    pendingArchiveRecovery: result.pendingArchiveRecovery,
    membershipInvalidatedKeys: result.membershipInvalidatedKeys,
    sharingUnchangedKeys: [...current].flatMap(([key, entry]) =>
      !invalidated.has(key) && sessionSharingEntriesEqual(result.previous.get(key), entry)
        ? [key]
        : [],
    ),
    // Committed rows that keep their incarnation; generation readers need not wait for them.
    generationUnchangedKeys: [...current].flatMap(([key, entry]) => {
      const previous = result.previous.get(key);
      return !invalidated.has(key) &&
        previous !== undefined &&
        previous.sessionId === entry.sessionId &&
        previous.lifecycleRevision === entry.lifecycleRevision
        ? [key]
        : [];
    }),
    previous: new Map(
      [...result.previous].map(([key, entry]) => [
        key,
        { sessionId: entry.sessionId, lifecycleRevision: entry.lifecycleRevision },
      ]),
    ),
    current,
    ...(fullEntries ? { fullEntries } : {}),
    projection,
    ...(unavailableParticipantKeys.size > 0
      ? { unavailableParticipantKeys: [...unavailableParticipantKeys] }
      : {}),
    ageChanges: [...current].map(([sessionKey, entry]) =>
      captureSessionEntryMaintenanceAgeChange({
        sessionKey,
        entry,
        previousEntry: result.previous.get(sessionKey),
      }),
    ),
    ...(source ? { source } : {}),
    changedKeys,
  };
  boundSessionEntryReplacementPublication(publication);
  return publication;
}

/** Keep every required receipt fact when its optional full snapshots exceed one bounded envelope. */
export function boundSessionEntryReplacementPublication(
  publication: SessionEntryReplacementPublication,
  envelope: unknown = publication,
): void {
  if (
    (!publication.fullEntries && !publication.actorPostimages) ||
    hasSessionEntryPublicationCapacity(envelope)
  ) {
    return;
  }
  delete publication.fullEntries;
  delete publication.actorPostimages;
  if (publication.source) {
    discardSessionEntryPublicationSource(publication.source);
  }
}
