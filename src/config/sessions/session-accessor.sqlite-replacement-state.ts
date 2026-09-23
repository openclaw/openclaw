import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { projectSessionSharingEntry } from "./session-accessor.sqlite-entry-cache-projection.js";
import type { SessionEntryReplacementPublication } from "./session-accessor.sqlite-entry-cache.js";
import { sqliteSessionEntriesEqual } from "./session-accessor.sqlite-entry-equality.js";
import {
  deleteLegacySessionEntryRows,
  readExactSessionEntryRow,
  writeSessionEntry,
  type ResolvedSessionEntryRow,
} from "./session-accessor.sqlite-entry-store.js";
import type {
  SessionEntryMaintenanceInput,
  SessionEntryMaintenancePlan,
} from "./session-accessor.sqlite-lifecycle-types.js";
import {
  applySessionEntryMaintenanceInDatabase,
  emptySessionEntryMaintenancePlan,
} from "./session-accessor.sqlite-maintenance-store.js";
import { replaceSessionOwnerInTransaction } from "./session-accessor.sqlite-owner.js";
import { readSessionEntryReplacementLabelOwnerKeys } from "./session-accessor.sqlite-replacement-read.js";
import { cloneSessionEntry } from "./session-accessor.sqlite-scope.js";
import type { SessionEntryReplacement } from "./session-accessor.types.js";
import type { SessionOwnerAssignment } from "./session-entry-provenance.js";
import type { SessionEntry } from "./types.js";

export type SqliteSessionEntryReplacement = SessionEntryReplacement & {
  previousSessionKeys?: readonly string[];
};

export type SessionEntryReplacementCommit = {
  expectedRows: Map<string, ResolvedSessionEntryRow>;
  labelOwnerKeys: string[];
  includeLabelOwners?: string;
  validationKeys: string[];
  replacements: SqliteSessionEntryReplacement[];
  consumePendingReset?: boolean;
  maintenance?: SessionEntryMaintenanceInput;
  ownerAssignment?: { sessionKey: string; owner: SessionOwnerAssignment };
};

export type SessionEntryReplacementCommitted = {
  previous: Map<string, SessionEntry>;
  current: Map<string, SessionEntry>;
  maintenancePlans: SessionEntryMaintenancePlan[];
  membershipInvalidatedKeys: string[];
};

/** Receipts carry only publication facts, never saved prompts or maintenance payloads. */
export function prepareSessionEntryReplacementPublication(
  result: SessionEntryReplacementCommitted,
): SessionEntryReplacementPublication {
  return {
    kind: "session-entry-replacements",
    membershipInvalidatedKeys: result.membershipInvalidatedKeys,
    previous: new Map(
      [...result.previous].map(([key, entry]) => [
        key,
        { sessionId: entry.sessionId, lifecycleRevision: entry.lifecycleRevision },
      ]),
    ),
    current: new Map(
      [...result.current].map(([key, entry]) => [key, projectSessionSharingEntry(entry)]),
    ),
    changedKeys: [
      ...new Set([
        ...result.previous.keys(),
        ...result.current.keys(),
        ...result.maintenancePlans.flatMap((plan) => plan.archivedSessionKeys),
      ]),
    ],
  };
}

/** One SQL owner serves admitted worker writes and the native rollback exception. */
export function commitSessionEntryReplacementsInDatabase(
  database: OpenClawAgentDatabase,
  input: SessionEntryReplacementCommit,
  assertCommitAllowed: () => void,
): SessionEntryReplacementCommitted {
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
  assertCommitAllowed();
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
      cloneSessionEntry(replacement.entry),
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
      ? applySessionEntryMaintenanceInDatabase(database, maintenance, () => preservation)
      : emptySessionEntryMaintenancePlan();
  return { previous, current, maintenancePlans: [maintenancePlan], membershipInvalidatedKeys };
}
