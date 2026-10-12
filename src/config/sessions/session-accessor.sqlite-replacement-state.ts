import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { getAdmittedSqliteSchemaFacts } from "../../infra/sqlite-schema-facts.js";
import { freezeJsonSnapshot } from "../../shared/immutable-data.js";
import { readOpenClawAgentDatabaseIdentity } from "../../state/openclaw-agent-db-identity.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { readSessionActivitySummary } from "./activity-summary.js";
import { isInternalSessionEffectsKey } from "./internal-session-key.js";
import { hasPendingSessionTranscriptArchives } from "./session-accessor.sqlite-archive-store-kernel.js";
import { assertSessionCreationLabelAvailable } from "./session-accessor.sqlite-creation-read.js";
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
import { captureSessionEntrySnapshot } from "./session-accessor.sqlite-entry-snapshot.js";
import {
  deleteLegacySessionEntryRows,
  readExactSessionEntryRow,
  writeSessionEntry,
} from "./session-accessor.sqlite-entry-store.js";
import { captureSessionEntryMaintenanceAgeChange } from "./session-accessor.sqlite-maintenance-age.js";
import {
  applySessionEntryMaintenanceInDatabase,
  emptySessionEntryMaintenancePlan,
} from "./session-accessor.sqlite-maintenance-store.js";
import { replaceSessionOwnerInTransaction } from "./session-accessor.sqlite-owner.js";
import { readSessionEntryReplacementLabelOwnerKeys } from "./session-accessor.sqlite-replacement-read.js";
import type {
  SessionEntryReplacementCommit,
  SessionEntryReplacementCommitted,
} from "./session-accessor.sqlite-replacement-types.js";
import { appendTranscriptEventsInTransaction } from "./session-accessor.sqlite-transcript-store.js";
import { readSessionTranscriptWatermarkInDatabase } from "./session-accessor.sqlite-transcript-watermark.js";
import { readSessionActorTransactionState } from "./session-actor-transaction.js";
import {
  captureSessionEntryPublicationSource,
  discardSessionEntryPublicationSource,
  hasSessionEntryPublicationCapacity,
} from "./session-entry-publication-source.js";
import { attachSessionEntrySnapshots } from "./session-entry-snapshot-values.js";
import type { SessionEntryWindowRow } from "./session-entry-window.types.js";
import type { SessionEntryWritePostimages } from "./session-entry-write-postimage.js";
import { readStagedSessionTranscriptAuthority } from "./session-transcript-authority.js";
import type { SessionMaintenancePreservationSnapshot } from "./store-maintenance-preserve-snapshot.types.js";
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
          ? readSessionTranscriptWatermarkInDatabase(database, projectedEntry.sessionId)
          : undefined,
      }),
    );
  }
  const source = getAdmittedSqliteSchemaFacts(database.db)
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
  ];
  const publication: SessionEntryReplacementPublication = {
    kind: "session-entry-replacements",
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
  if (!publication.fullEntries || hasSessionEntryPublicationCapacity(envelope)) {
    return;
  }
  delete publication.fullEntries;
  if (publication.source) {
    discardSessionEntryPublicationSource(publication.source);
  }
}

/** One SQL owner serves admitted worker writes and the native rollback exception. */
export function commitSessionEntryReplacementsInDatabase(
  database: OpenClawAgentDatabase,
  input: SessionEntryReplacementCommit,
  beforeReplacements: () => void,
  refreshCandidates?: (sessionKeys: readonly string[]) => SessionMaintenancePreservationSnapshot,
  onArchived?: (sessionKey: string, previous: SessionEntry, current: SessionEntry) => void,
  postimages?: SessionEntryWritePostimages,
): SessionEntryReplacementCommitted {
  if (input.labelClaim) {
    assertSessionCreationLabelAvailable(
      database,
      input.labelClaim.sessionKey,
      input.labelClaim.label,
    );
  }
  if (
    input.includeLabelOwners !== undefined &&
    JSON.stringify(
      readSessionEntryReplacementLabelOwnerKeys(database, input.includeLabelOwners),
    ) !== JSON.stringify(input.labelOwnerKeys)
  ) {
    throw new Error("SQLite session label owners changed before replacement");
  }
  const transactionRows = new Map<string, ResolvedSessionEntryRow>();
  const windows = new Map<string, SessionEntryWindowRow | null>();
  const writtenPostimages: SessionEntryWritePostimages = postimages ?? new Map();
  for (const sessionKey of input.validationKeys) {
    const transactionRow = readExactSessionEntryRow(database, sessionKey, "full", undefined, true);
    const expectedRow = input.expectedRows.get(sessionKey);
    if (
      transactionRow?.row.entry_json !== expectedRow?.row.entry_json ||
      !sqliteSessionEntriesEqual(transactionRow?.entry, expectedRow?.entry)
    ) {
      throw new Error(`SQLite session entry changed before replacement for ${sessionKey}`);
    }
    if (transactionRow) {
      transactionRows.set(sessionKey, transactionRow);
      const window = transactionRow.row.window;
      if (window !== undefined) {
        windows.set(transactionRow.entry.sessionId, window);
      }
    }
  }
  beforeReplacements();
  if (input.preparedTranscript) {
    const { sessionKey, sessionId, events } = input.preparedTranscript;
    appendTranscriptEventsInTransaction(
      database,
      { agentId: database.agentId, path: database.path, sessionKey, sessionId },
      events,
    );
  }
  const previous = new Map<string, SessionEntry>();
  const current = new Map<string, SessionEntry>();
  const membershipInvalidatedKeys: string[] = [];
  for (const replacement of input.replacements) {
    const sourceEntries = [
      replacement.sessionKey,
      ...(replacement.previousSessionKeys ?? []),
    ].flatMap((sessionKey) => {
      const entry = transactionRows.get(sessionKey)?.entry;
      return entry ? [{ entry, sessionKey }] : [];
    });
    const selectedBefore = sourceEntries.toSorted(
      (left, right) => (right.entry.updatedAt ?? 0) - (left.entry.updatedAt ?? 0),
    )[0]?.entry;
    for (const { entry, sessionKey } of sourceEntries) {
      if (!previous.has(sessionKey)) {
        previous.set(sessionKey, entry);
      }
    }
    const canonical = transactionRows.get(replacement.sessionKey);
    const canonicalFacts = canonical && captureSessionEntrySnapshot(canonical);
    const previousWindow = windows.get(replacement.entry.sessionId);
    const written = writeSessionEntry(
      database,
      replacement.sessionKey,
      structuredClone(replacement.entry),
      {
        ...(input.consumePendingReset ? { consumePendingReset: true } : {}),
        previousEntry: selectedBefore ?? null,
        canonicalPreviousEntry: canonical?.entry ?? null,
        canonicalPreviousRow: canonical?.row,
        canonicalPreviousWindow:
          previousWindow !== undefined
            ? { sessionId: replacement.entry.sessionId, row: previousWindow }
            : canonicalFacts?.window,
        canonicalPreviousSideTables: canonicalFacts?.sideTables,
        postimages: writtenPostimages,
      },
    );
    deleteLegacySessionEntryRows(
      database,
      [...(replacement.previousSessionKeys ?? [])],
      replacement.sessionKey,
      {
        rehomeMembers: selectedBefore?.sessionId === replacement.entry.sessionId,
        validatedEntries: new Map(
          [...transactionRows].map(([key, selected]) => [key, selected.entry]),
        ),
        postimages: writtenPostimages,
      },
    );
    // Each later replacement starts from the preceding write, including shared physical windows.
    const postimage = writtenPostimages.get(replacement.sessionKey);
    if (postimage) {
      transactionRows.set(replacement.sessionKey, {
        entry: postimage.entry,
        row: {
          ...postimage.row,
          member_ids_json: postimage.sideTables.memberIdsJson,
          board_present: postimage.sideTables.hasBoard ? 1 : 0,
        },
      });
      windows.set(postimage.entry.sessionId, postimage.window);
    }
    for (const previousKey of replacement.previousSessionKeys ?? []) {
      if (previousKey !== replacement.sessionKey) {
        transactionRows.delete(previousKey);
      }
    }
    if (replacement.previousSessionKeys?.some((key) => key !== replacement.sessionKey)) {
      membershipInvalidatedKeys.push(replacement.sessionKey);
    }
    current.set(replacement.sessionKey, written);
  }
  const maintenance = input.maintenance;
  if (input.ownerAssignment) {
    const { sessionKey, owner } = input.ownerAssignment;
    if (
      !current.has(sessionKey) ||
      !replaceSessionOwnerInTransaction(database, sessionKey, owner, writtenPostimages)
    ) {
      throw new Error("Session owner assignment lost its creation target");
    }
  }
  const preservation = maintenance?.preservation;
  const maintenancePlan =
    maintenance && preservation
      ? applySessionEntryMaintenanceInDatabase(
          database,
          maintenance,
          () => preservation,
          (sessionKey, previousEntry, currentEntry) => {
            if (!previous.has(sessionKey)) {
              previous.set(sessionKey, previousEntry);
            }
            current.set(sessionKey, currentEntry);
            onArchived?.(sessionKey, previousEntry, currentEntry);
          },
          refreshCandidates,
          writtenPostimages,
        )
      : emptySessionEntryMaintenancePlan();
  for (const sessionKey of current.keys()) {
    const postimage = writtenPostimages.get(sessionKey);
    if (postimage) {
      current.set(sessionKey, postimage.entry);
    } else {
      current.delete(sessionKey);
    }
  }
  return {
    // Fresh creation must not retry another session's failed export.
    pendingArchiveRecovery:
      input.checkPendingArchiveRecovery === true &&
      previous.size > 0 &&
      hasPendingSessionTranscriptArchives(database),
    previous,
    current,
    maintenancePlans: [maintenancePlan],
    membershipInvalidatedKeys,
  };
}
