import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { createSqliteCommitReceipt } from "../../infra/sqlite-commit-receipt.js";
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
import type { SessionMaintenancePreservationSnapshot } from "./store-maintenance-preserve-snapshot.types.js";
import type { SessionEntry } from "./types.js";

/** Receipts carry only publication facts, never saved prompts or maintenance payloads. */
export function prepareSessionEntryReplacementPublication(
  result: SessionEntryReplacementCommitted,
  database: OpenClawAgentDatabase,
): SessionEntryReplacementPublication {
  const archived = new Set(
    result.maintenancePlans.flatMap((plan) =>
      plan.archivedEntries.map(({ sessionKey }) => sessionKey),
    ),
  );
  const invalidated = new Set([...result.membershipInvalidatedKeys, ...archived]);
  const current = new Map<string, SessionEntry>();
  const projection = new Map<string, SessionEntryProjectionFacts>();
  let readCommitted: ReturnType<typeof prepareExactSessionEntryRowReads> | undefined;
  for (const key of result.current.keys()) {
    readCommitted ??= prepareExactSessionEntryRowReads(
      database,
      [...result.current.keys()],
      "list",
      undefined,
      { includeBoardPresence: true, includeMembership: true },
    );
    // Read the final persisted bytes and side tables after assignment, alias moves and maintenance.
    const committed = readCommitted(key);
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
    current.set(key, freezeJsonSnapshot(committed.entry));
    const { entry } = committed;
    projection.set(
      key,
      freezeJsonSnapshot({
        membership: [
          key,
          isInternalSessionEffectsKey(key)
            ? null
            : (normalizeOptionalString(entry.category) ?? null),
          memberIds,
          {
            ...(entry.participants ? { participants: entry.participants } : {}),
            ...(entry.participantCount === undefined
              ? {}
              : { participantCount: entry.participantCount }),
          },
          entry.sessionId,
        ],
        hasBoard: committed.row.board_present === 1,
        activitySummaryWatermark: readSessionActivitySummary(entry)
          ? readSessionTranscriptWatermarkInDatabase(database, entry.sessionId)
          : undefined,
      }),
    );
  }
  const source = getAdmittedSqliteSchemaFacts(database.db)
    ? {
        ...readOpenClawAgentDatabaseIdentity(database),
        revision: readSessionNodesGeneration(database.db),
      }
    : undefined;
  const changedKeys = [
    ...new Set([...result.previous.keys(), ...result.current.keys(), ...archived]),
  ];
  const receipt =
    source &&
    createSqliteCommitReceipt<
      { entry: SessionEntry; projection: SessionEntryProjectionFacts },
      typeof source
    >({
      source,
      domain: "session-entry-replacement",
      keys: changedKeys,
      readFact(key) {
        const entry = current.get(key);
        const facts = projection.get(key);
        if (entry && facts) {
          return { kind: "postimage", value: { entry, projection: facts } };
        }
        return result.previous.has(key) && !current.has(key)
          ? { kind: "absent" }
          : { kind: "unknown" };
      },
    });
  return {
    kind: "session-entry-replacements",
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
    projection,
    ageChanges: [...current].map(([sessionKey, entry]) =>
      captureSessionEntryMaintenanceAgeChange({
        sessionKey,
        entry,
        previousEntry: result.previous.get(sessionKey),
      }),
    ),
    ...(source ? { source, receipt } : {}),
    changedKeys,
  };
}

/** One SQL owner serves admitted worker writes and the native rollback exception. */
export function commitSessionEntryReplacementsInDatabase(
  database: OpenClawAgentDatabase,
  input: SessionEntryReplacementCommit,
  beforeReplacements: () => void,
  refreshCandidates?: (sessionKeys: readonly string[]) => SessionMaintenancePreservationSnapshot,
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
          undefined,
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
