import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  getAdmittedSqliteSchemaFacts,
  readSqliteNativeMutationRevision,
} from "../../infra/sqlite-schema-facts.js";
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

/** Complete transaction-local postimages, invalid after any subsequent native mutation. */
export type SessionEntryReplacementPostimages = {
  database: OpenClawAgentDatabase["db"];
  revision: number;
  entries: ReadonlyMap<string, SessionEntry>;
  sideTables?: ReadonlyMap<string, { memberIdsJson: string; hasBoard: boolean }>;
};

/** Display metadata and bounded full-entry facts share the writer's final persisted read. */
export function prepareSessionEntryReplacementPublication(
  result: SessionEntryReplacementCommitted,
  database: OpenClawAgentDatabase,
  options?: { captureFullFacts?: boolean; postimages?: SessionEntryReplacementPostimages },
): SessionEntryReplacementPublication {
  const retained =
    options?.postimages?.database === database.db &&
    options.postimages.revision === readSqliteNativeMutationRevision(database.db)
      ? options.postimages
      : undefined;
  const reusePostimages =
    retained !== undefined && [...result.current.keys()].every((key) => retained.entries.has(key));
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
      const postimage =
        reusePostimages || fullEntries
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
    const retainedSideTables = reusePostimages ? retained?.sideTables?.get(key) : undefined;
    const writtenEntry = written.get(key);
    let committed: ResolvedSessionEntryRow | undefined;
    if (writtenEntry) {
      const row = readWritten?.(key)?.row;
      committed = row ? { entry: writtenEntry, row } : undefined;
      if (!committed) {
        throw new Error(`Session publication lost its committed metadata: ${key}`);
      }
    } else if (!retainedSideTables) {
      readCommitted ??= prepareExactSessionEntryRowReads(
        database,
        [...result.current.keys()].filter((currentKey) => !written.has(currentKey)),
        fullEntries ? "full" : "list",
        undefined,
        {
          includeBoardPresence: true,
          includeMembership: true,
          ...(reusePostimages ? { projectParticipants: false as const } : {}),
          onParticipantProjectionError: (sessionKey) => unavailableParticipantKeys.add(sessionKey),
        },
      );
      // Assignment, aliases and changed generations still acquire final side-table facts.
      committed = readCommitted(key);
      if (!committed) {
        throw new Error(`Session publication lost its committed metadata: ${key}`);
      }
    }
    const memberIds: unknown = JSON.parse(
      retainedSideTables?.memberIdsJson ?? committed?.row.member_ids_json ?? "null",
    );
    if (
      !Array.isArray(memberIds) ||
      !memberIds.every((id): id is string => typeof id === "string")
    ) {
      throw new Error(`Session publication lost its committed membership: ${key}`);
    }
    const committedEntry =
      (reusePostimages ? retained?.entries.get(key) : undefined) ?? committed?.entry;
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
        hasBoard: retainedSideTables?.hasBoard ?? committed?.row.board_present === 1,
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
  const transactionRows = new Map<string, ResolvedSessionEntryRow>();
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
      transactionRows.set(sessionKey, transactionRow);
    }
  }
  const validatedRevision = readSqliteNativeMutationRevision(database.db);
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
      previous.set(sessionKey, entry);
    }
    const canReuseRow =
      validatedRevision !== undefined &&
      validatedRevision === readSqliteNativeMutationRevision(database.db);
    const written = writeSessionEntry(
      database,
      replacement.sessionKey,
      structuredClone(replacement.entry),
      {
        ...(input.consumePendingReset ? { consumePendingReset: true } : {}),
        previousEntry: selectedBefore ?? null,
        canonicalPreviousEntry: transactionRows.get(replacement.sessionKey)?.entry ?? null,
        canonicalPreviousRow: canReuseRow
          ? transactionRows.get(replacement.sessionKey)?.row
          : undefined,
        forceSnapshotWrite: !canReuseRow,
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
