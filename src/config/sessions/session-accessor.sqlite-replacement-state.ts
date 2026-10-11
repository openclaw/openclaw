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
import { prepareExactSessionEntryRowReads } from "./session-accessor.sqlite-entry-read.js";
import { readSessionNodesGeneration } from "./session-accessor.sqlite-entry-revision.js";
import {
  deleteLegacySessionEntryRows,
  readExactSessionEntryRow,
  readWrittenSessionEntryPostimage,
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
  hasSessionEntryPublicationCapacity,
} from "./session-entry-publication-source.js";
import { attachSessionEntrySnapshots } from "./session-entry-snapshots.js";
import { readStagedSessionTranscriptAuthority } from "./session-transcript-authority.js";
import type { SessionMaintenancePreservationSnapshot } from "./store-maintenance-preserve-snapshot.types.js";
import type { SessionEntry } from "./types.js";

/** Display metadata and bounded full-entry facts share the writer's final persisted read. */
export function prepareSessionEntryReplacementPublication(
  result: SessionEntryReplacementCommitted,
  database: OpenClawAgentDatabase,
  options?: { captureFullFacts?: boolean },
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
  const written = new Map(
    [...result.current].flatMap(([key, entry]) => {
      const postimage = fullEntries
        ? undefined
        : readWrittenSessionEntryPostimage(database, key, entry);
      return postimage ? [[key, postimage] as const] : [];
    }),
  );
  const readWritten =
    written.size === 0
      ? undefined
      : prepareExactSessionEntryRowReads(database, [...written.keys()], "list", undefined, {
          includeBoardPresence: true,
          includeMembership: true,
          projectParticipants: false,
        });
  let readCommitted: ReturnType<typeof prepareExactSessionEntryRowReads> | undefined;
  for (const key of result.current.keys()) {
    const writtenEntry = written.get(key);
    const row = writtenEntry ? readWritten?.(key)?.row : undefined;
    if (!writtenEntry) {
      readCommitted ??= prepareExactSessionEntryRowReads(
        database,
        [...result.current.keys()].filter((currentKey) => !written.has(currentKey)),
        fullEntries ? "full" : "list",
        undefined,
        {
          includeBoardPresence: true,
          includeMembership: true,
          onParticipantProjectionError: (sessionKey) => unavailableParticipantKeys.add(sessionKey),
        },
      );
    }
    // Later assignment, alias moves and maintenance revoke the writer's exact postimage.
    const committed = writtenEntry ? row && { entry: writtenEntry, row } : readCommitted?.(key);
    if (!committed) {
      throw new Error(`Session publication lost its committed metadata: ${key}`);
    }
    const memberIds: unknown = JSON.parse(committed.row.member_ids_json ?? "null");
    if (
      !Array.isArray(memberIds) ||
      !memberIds.every((id): id is string => typeof id === "string")
    ) {
      throw new Error(`Session publication lost its committed membership: ${key}`);
    }
    const entry = freezeJsonSnapshot(
      attachSessionEntrySnapshots({ ...committed.entry }, {}, "list"),
    );
    current.set(key, entry);
    if (unavailableParticipantKeys.has(key)) {
      continue;
    }
    fullEntries?.set(key, freezeJsonSnapshot(committed.entry));
    const projectedEntry = committed.entry;
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
        hasBoard: committed.row.board_present === 1,
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
    delete publication.source.writeToken;
  }
}

/** One SQL owner serves admitted worker writes and the native rollback exception. */
export function commitSessionEntryReplacementsInDatabase(
  database: OpenClawAgentDatabase,
  input: SessionEntryReplacementCommit,
  beforeReplacements: () => void,
  refreshCandidates?: (sessionKeys: readonly string[]) => SessionMaintenancePreservationSnapshot,
  onArchived?: (sessionKey: string, previous: SessionEntry, current: SessionEntry) => void,
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
  const transactionEntries = new Map<string, SessionEntry>();
  for (const sessionKey of input.validationKeys) {
    const transactionRow = readExactSessionEntryRow(database, sessionKey);
    const expectedRow = input.expectedRows.get(sessionKey);
    if (
      transactionRow?.row.entry_json !== expectedRow?.row.entry_json ||
      !sqliteSessionEntriesEqual(transactionRow?.entry, expectedRow?.entry)
    ) {
      throw new Error(`SQLite session entry changed before replacement for ${sessionKey}`);
    }
    if (transactionRow) {
      transactionEntries.set(sessionKey, transactionRow.entry);
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
      const entry = transactionEntries.get(sessionKey);
      return entry ? [{ entry, sessionKey }] : [];
    });
    const selectedBefore = sourceEntries.toSorted(
      (left, right) => (right.entry.updatedAt ?? 0) - (left.entry.updatedAt ?? 0),
    )[0]?.entry;
    for (const { entry, sessionKey } of sourceEntries) {
      previous.set(sessionKey, entry);
    }
    const written = writeSessionEntry(
      database,
      replacement.sessionKey,
      structuredClone(replacement.entry),
      {
        ...(input.consumePendingReset ? { consumePendingReset: true } : {}),
        previousEntry: selectedBefore ?? null,
        canonicalPreviousEntry: transactionEntries.get(replacement.sessionKey) ?? null,
      },
    );
    deleteLegacySessionEntryRows(
      database,
      [...(replacement.previousSessionKeys ?? [])],
      replacement.sessionKey,
      {
        rehomeMembers: selectedBefore?.sessionId === replacement.entry.sessionId,
      },
    );
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
      !replaceSessionOwnerInTransaction(database, sessionKey, owner)
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
          onArchived,
          refreshCandidates,
        )
      : emptySessionEntryMaintenancePlan();
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
