import { isDeepStrictEqual } from "node:util";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { hasPendingSessionTranscriptArchives } from "./session-accessor.sqlite-archive-store-kernel.js";
import { assertSessionCreationLabelAvailable } from "./session-accessor.sqlite-creation-read.js";
import { sqliteSessionEntriesEqual } from "./session-accessor.sqlite-entry-equality.js";
import {
  prepareExactSessionEntryRowReads,
  type ResolvedSessionEntryRow,
} from "./session-accessor.sqlite-entry-read.js";
import { captureSessionEntrySnapshot } from "./session-accessor.sqlite-entry-snapshot.js";
import {
  deleteLegacySessionEntryRows,
  writeSessionEntry,
} from "./session-accessor.sqlite-entry-store.js";
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
import { commitSessionCreationReceipt } from "./session-creation-receipts.js";
import type { SessionEntryWindowRow } from "./session-entry-window.types.js";
import type { SessionEntryWritePostimages } from "./session-entry-write-postimage.js";
import type { SessionMaintenancePreservationSnapshot } from "./store-maintenance-preserve-snapshot.types.js";
import type { SessionEntry } from "./types.js";

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
  let readValidation: ReturnType<typeof prepareExactSessionEntryRowReads> | undefined;
  for (const sessionKey of input.validationKeys) {
    readValidation ??= prepareExactSessionEntryRowReads(
      database,
      input.validationKeys,
      "full",
      undefined,
      { includeWindowFacts: true, includeBoardPresence: true, includeMembership: true },
    );
    const transactionRow = readValidation(sessionKey);
    const expectedRow = input.expectedRows.get(sessionKey);
    const unchanged = input.fieldPatch
      ? transactionRow && expectedRow
        ? transactionRow.entry.sessionId === expectedRow.entry.sessionId &&
          transactionRow.entry.lifecycleRevision === expectedRow.entry.lifecycleRevision &&
          input.fieldPatch.guardFields.every((field) =>
            isDeepStrictEqual(transactionRow.entry[field], expectedRow.entry[field]),
          )
        : transactionRow === expectedRow
      : transactionRow?.row.entry_json === expectedRow?.row.entry_json &&
        sqliteSessionEntriesEqual(transactionRow?.entry, expectedRow?.entry);
    if (!unchanged) {
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
    let next = replacement.entry;
    if (input.fieldPatch) {
      const expected = input.expectedRows.get(replacement.sessionKey)?.entry;
      if (!canonical || !expected || replacement.previousSessionKeys?.length) {
        throw new Error("Field-scoped session patches require an existing canonical entry");
      }
      // Merge against the transaction's complete row so concurrent activity and cold
      // snapshots survive; the existing writer still publishes a complete postimage.
      next = { ...canonical.entry };
      for (const field of input.fieldPatch.fields) {
        const value = replacement.entry[field];
        if (value === undefined) {
          delete next[field];
        } else {
          Object.assign(next, { [field]: value });
        }
      }
      next.updatedAt =
        replacement.entry.updatedAt === expected.updatedAt
          ? canonical.entry.updatedAt
          : Math.max(canonical.entry.updatedAt, replacement.entry.updatedAt);
    }
    const canonicalFacts = canonical && captureSessionEntrySnapshot(canonical);
    const previousWindow = windows.get(next.sessionId);
    const written = writeSessionEntry(
      database,
      replacement.sessionKey,
      { ...next },
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
        publishConversationBinding: (replacement.previousSessionKeys?.length ?? 0) > 0,
      },
    );
    if (replacement.previousSessionKeys?.length) {
      deleteLegacySessionEntryRows(
        database,
        [...replacement.previousSessionKeys],
        replacement.sessionKey,
        {
          rehomeMembers: selectedBefore?.sessionId === replacement.entry.sessionId,
          validatedEntries: new Map(
            sourceEntries.map(({ sessionKey, entry }) => [sessionKey, entry]),
          ),
          postimages: writtenPostimages,
        },
      );
    }
    // Each later replacement starts from the preceding write, including shared physical windows.
    const postimage = writtenPostimages.get(replacement.sessionKey);
    if (postimage) {
      // Repeated keys are a mutation batch even when the final write returns to its start.
      postimage.changed ||= current.has(replacement.sessionKey);
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
  if (input.creationOperation) {
    const created = input.replacements[0];
    if (!created || input.replacements.length !== 1) {
      throw new Error("Creation receipt requires one exact session target");
    }
    commitSessionCreationReceipt(
      database,
      input.creationOperation,
      created.sessionKey,
      created.entry,
    );
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
    ...(input.fieldPatch
      ? {
          patchDiffBaselines: new Map(
            [...current].flatMap(([key, entry]) =>
              entry.sessionDiffBaseline ? [[key, entry.sessionDiffBaseline] as const] : [],
            ),
          ),
        }
      : {}),
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
