import { isDeepStrictEqual } from "node:util";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  isAgentHarnessSessionKey,
  MODEL_SELECTION_LOCK_REMOVAL_MESSAGE,
} from "../../sessions/agent-harness-session-key.js";
import {
  readOpenClawAgentDatabaseIdentity,
  type OpenClawAgentDatabaseIdentity,
} from "../../state/openclaw-agent-db-identity.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import type { SessionStateDeletePlan } from "./session-accessor.sqlite-archive-types.js";
import type { DeleteSessionEntryLifecycleParams } from "./session-accessor.sqlite-contract.js";
import {
  sqliteLifecycleTargetSnapshotsEqual,
  type SqliteLifecycleTargetSnapshot,
} from "./session-accessor.sqlite-entry-equality.js";
import { readLifecycleTargetSnapshot } from "./session-accessor.sqlite-entry-store.js";
import {
  readSqliteSessionGenerationClaim,
  readSqliteSessionGenerationWindows,
} from "./session-accessor.sqlite-generation-copy.js";
import {
  collectSessionStateIdsForEntry,
  shouldRemoveSessionEntry,
  planSessionStateDeleteIfUnreferenced,
  readSessionGenerationIdsForKeys,
  planSessionStateAfterEntryRemoval,
  readReferencedSessionIdsAfterTargetMutation,
} from "./session-accessor.sqlite-lifecycle-state.js";
import type { SqliteSessionDeletionScope } from "./session-accessor.sqlite-lifecycle-types.js";
import { readSessionNodeArtifactFingerprint } from "./session-accessor.sqlite-node-artifacts.js";
import { collectSessionAdmissionReferences } from "./session-history-eviction-candidates.js";
import type { InternalSessionEntry as SessionEntry } from "./types.js";

/** Transportable planning facts; live guards and native identity remain with their owners. */
type SessionDeletionPlanningParams = Omit<
  DeleteSessionEntryLifecycleParams,
  "commitGuard" | "expectedDatabaseIdentity" | "descendantRunBasis"
>;

type SessionEntryDeletionPlanInput = {
  deleteParams: SessionDeletionPlanningParams;
  archiveDirectory: string;
  admissionIdentities: readonly string[];
  allowLockedEntryRemoval: boolean;
  expectedPluginOwnerId?: string;
};
type SessionEntryDeletionPlanResult =
  | { kind: "missing" }
  | { kind: "expected-entry-mismatch" }
  | {
      kind: "ready";
      value: {
        archiveDirectory: string;
        current: SqliteLifecycleTargetSnapshot[number];
        entryPlans: SessionStateDeletePlan[];
        historicalGenerationIds: string[];
        targetSnapshot: SqliteLifecycleTargetSnapshot;
      };
    };

type SessionDeletionPlanningValidation = {
  deleteParams: SessionDeletionPlanningParams;
  preparedTargetSnapshot: SqliteLifecycleTargetSnapshot;
  scope?: SqliteSessionDeletionScope;
};
type SessionHistoricalDeletionCheckInput = {
  validation: SessionDeletionPlanningValidation;
  sessionId: string;
  admissionIdentities: readonly string[];
};
type SessionHistoricalDeletionPlanInput = SessionHistoricalDeletionCheckInput & {
  archiveDirectory: string;
  archiveTranscript: boolean;
};
type SessionHistoricalDeletionPlanResult =
  | { kind: "expected-entry-mismatch" }
  | { kind: "skip" }
  | { kind: "ready"; plan: SessionStateDeletePlan };
type SessionHistoricalDeletionCheckResult =
  | { kind: "expected-entry-mismatch" }
  | { kind: "ready"; protectedSessionIds: string[] };

export type SessionDeletionPlanningOperation =
  | { operation: "entry"; input: SessionEntryDeletionPlanInput }
  | { operation: "history"; input: SessionHistoricalDeletionPlanInput }
  | { operation: "check"; input: SessionHistoricalDeletionCheckInput };

export type SessionDeletionPlanningResult =
  | { operation: "entry"; value: SessionEntryDeletionPlanResult }
  | { operation: "history"; value: SessionHistoricalDeletionPlanResult }
  | { operation: "check"; value: SessionHistoricalDeletionCheckResult };

export function prepareSessionDeletionInDatabase(
  database: OpenClawAgentDatabase,
  planning: SessionDeletionPlanningOperation,
  expectedDatabaseIdentity?: OpenClawAgentDatabaseIdentity,
): SessionDeletionPlanningResult {
  switch (planning.operation) {
    case "entry":
      return {
        operation: planning.operation,
        value: prepareSessionEntryDeletionInDatabase(
          database,
          planning.input,
          expectedDatabaseIdentity,
        ),
      };
    case "history":
      return {
        operation: planning.operation,
        value: prepareSessionHistoricalDeletionInDatabase(
          database,
          planning.input,
          expectedDatabaseIdentity,
        ),
      };
    case "check":
      return {
        operation: planning.operation,
        value: prepareSessionHistoricalReclamationInDatabase(
          database,
          planning.input,
          expectedDatabaseIdentity,
        ),
      };
  }
  throw new Error("Unknown SQLite session deletion planning operation");
}

/** Native identity is checked locally; it is never serialized into the planning input. */
function prepareSessionEntryDeletionInDatabase(
  database: OpenClawAgentDatabase,
  input: SessionEntryDeletionPlanInput,
  expectedDatabaseIdentity?: OpenClawAgentDatabaseIdentity,
): SessionEntryDeletionPlanResult {
  const params = { ...input.deleteParams, expectedDatabaseIdentity };
  const { archiveDirectory, allowLockedEntryRemoval, expectedPluginOwnerId } = input;
  const targetSnapshot = readLifecycleTargetSnapshot(database, params.target);
  const current = targetSnapshot[0];
  if (!current) {
    return { kind: "missing" };
  }
  if (!shouldDeleteSqliteSessionEntryLifecycle(database, current.entry, params)) {
    return { kind: "expected-entry-mismatch" };
  }
  if (current.entry.modelSelectionLocked === true && !allowLockedEntryRemoval) {
    throw new Error(MODEL_SELECTION_LOCK_REMOVAL_MESSAGE);
  }
  if (
    expectedPluginOwnerId &&
    targetSnapshot.some(
      ({ entry, sessionKey }) =>
        isAgentHarnessSessionKey(sessionKey) ||
        entry.agentHarnessId !== undefined ||
        entry.modelSelectionLocked !== true ||
        normalizeOptionalString(entry.pluginOwnerId) !== expectedPluginOwnerId,
    )
  ) {
    throw new Error(MODEL_SELECTION_LOCK_REMOVAL_MESSAGE);
  }
  const deleteTranscriptState =
    params.archiveTranscript || params.deleteTranscriptWithoutArchive === true;
  const ownedGenerationIds = deleteTranscriptState
    ? readSessionGenerationIdsForKeys(database, [
        params.target.canonicalKey,
        ...params.target.storeKeys,
        ...targetSnapshot.map((row) => row.sessionKey),
      ])
    : [];
  const referencedAfterDelete = readReferencedSessionIdsAfterTargetMutation(
    database,
    params.target,
    deleteTranscriptState
      ? [
          ...new Set([
            ...targetSnapshot.flatMap(({ entry }) => collectSessionStateIdsForEntry(entry)),
            ...ownedGenerationIds,
          ]),
        ]
      : [],
  );
  // SQLite transcript state is keyed by session id; sessionFile is only its
  // marker. Materialization dedupes aliases that share the same state owner.
  const entryPlans = deleteTranscriptState
    ? targetSnapshot.flatMap(({ entry }) =>
        planSessionStateAfterEntryRemoval({
          archiveDirectory,
          archiveTranscript: params.archiveTranscript,
          database,
          entry,
          reason: "deleted",
          referencedSessionIds: referencedAfterDelete,
        }),
      )
    : [];
  const entryPlanIds = new Set(entryPlans.map((plan) => plan.sessionId));
  // Ids only — archive extraction happens lazily one generation at a time
  // outside the SQLite write transaction.
  const historicalGenerationIds = deleteTranscriptState
    ? ownedGenerationIds.filter((sessionId) => !entryPlanIds.has(sessionId))
    : [];
  // Historical generations are reclaimed BEFORE the entry-removing
  // transaction, one generation per transaction: an archive or delete
  // failure aborts the whole deletion while the live entry still exists,
  // so a retry rediscovers the remaining history. Acknowledging deletion
  // first would let surviving generations become unreachable via delete.
  // Preflight the admission fence over every generation BEFORE deleting
  // anything, so an in-flight run rejects the whole deletion instead of
  // aborting it midway through committed removals.
  const preflightFence = collectSessionAdmissionReferences({
    database,
    admissionIdentities: input.admissionIdentities,
  });
  for (const sessionId of historicalGenerationIds) {
    if (preflightFence.has(sessionId) && !referencedAfterDelete.has(sessionId)) {
      throw new Error(
        `cannot delete session history while work is in flight for ${sessionId}; retry after the run completes`,
      );
    }
  }
  return {
    kind: "ready",
    value: { archiveDirectory, current, entryPlans, historicalGenerationIds, targetSnapshot },
  };
}

/** Preserve reference and live-admission protection before materializing one historical generation. */
function prepareSessionHistoricalDeletionInDatabase(
  database: OpenClawAgentDatabase,
  input: SessionHistoricalDeletionPlanInput,
  expectedDatabaseIdentity?: OpenClawAgentDatabaseIdentity,
): SessionHistoricalDeletionPlanResult {
  const validation = {
    ...input.validation,
    deleteParams: { ...input.validation.deleteParams, expectedDatabaseIdentity },
  };
  const { sessionId } = input;
  if (!readValidatedSessionDeletionTarget(database, validation)) {
    return { kind: "expected-entry-mismatch" };
  }
  const referencedAfterDelete = readReferencedSessionIdsAfterTargetMutation(
    database,
    validation.deleteParams.target,
    [sessionId],
  );
  if (referencedAfterDelete.has(sessionId)) {
    return { kind: "skip" };
  }
  const admissionProtected = collectSessionAdmissionReferences({
    database,
    admissionIdentities: input.admissionIdentities,
  });
  if (admissionProtected.has(sessionId)) {
    throw new Error(
      `cannot delete session history while work is in flight for ${sessionId}; retry after the run completes`,
    );
  }
  const plan = planSessionStateDeleteIfUnreferenced({
    archiveDirectory: input.archiveDirectory,
    archiveTranscript: input.archiveTranscript,
    database,
    reason: "deleted",
    referencedSessionIds: referencedAfterDelete,
    sessionId,
  });
  return plan ? { kind: "ready", plan } : { kind: "skip" };
}

/** Recheck the same generation after archive materialization; this snapshot grants no authority. */
function prepareSessionHistoricalReclamationInDatabase(
  database: OpenClawAgentDatabase,
  input: SessionHistoricalDeletionCheckInput,
  expectedDatabaseIdentity?: OpenClawAgentDatabaseIdentity,
): SessionHistoricalDeletionCheckResult {
  const validation = {
    ...input.validation,
    deleteParams: { ...input.validation.deleteParams, expectedDatabaseIdentity },
  };
  if (!readValidatedSessionDeletionTarget(database, validation)) {
    return { kind: "expected-entry-mismatch" };
  }
  const protectedSessionIds = collectSessionAdmissionReferences({
    database,
    admissionIdentities: input.admissionIdentities,
  });
  if (protectedSessionIds.has(input.sessionId)) {
    throw new Error(
      `cannot delete session history while work is in flight for ${input.sessionId}; retry after the run completes`,
    );
  }
  return { kind: "ready", protectedSessionIds: [...protectedSessionIds] };
}

function shouldDeleteSqliteSessionEntryLifecycle(
  database: OpenClawAgentDatabase,
  entry: SessionEntry | undefined,
  params: DeleteSessionEntryLifecycleParams,
  scope: SqliteSessionDeletionScope = { kind: "entry", phase: "plan" },
): entry is SessionEntry {
  if (
    params.expectedDatabaseIdentity !== undefined &&
    params.expectedDatabaseIdentity !== readOpenClawAgentDatabaseIdentity(database).identity
  ) {
    return false;
  }
  if (
    !shouldRemoveSessionEntry(entry, {
      expectedEntry: params.expectedEntry || undefined,
      expectedSessionId: params.expectedSessionId,
      expectedLifecycleRevision: params.expectedLifecycleRevision,
      expectedUpdatedAt: params.expectedUpdatedAt,
    })
  ) {
    return false;
  }
  if (
    scope.kind === "entry" &&
    params.expectedNodeArtifactFingerprint !== undefined &&
    params.expectedNodeArtifactFingerprint !==
      readSessionNodeArtifactFingerprint(database, params.target.canonicalKey)
  ) {
    return false;
  }
  if (params.expectedGenerations) {
    const expected = new Map(
      params.expectedGenerations.map((generation) => [generation.window.session_id, generation]),
    );
    const windows = readSqliteSessionGenerationWindows(
      database,
      scope.kind === "entry" ? [params.target.canonicalKey, ...params.target.storeKeys] : [],
      scope.kind === "entry" ? collectSessionStateIdsForEntry(entry) : [scope.sessionId],
    );
    // Historical cleanup commits one generation at a time; already-copied removals are allowed.
    if (
      windows.some((window) => {
        const generation = expected.get(window.session_id);
        return (
          !generation ||
          !isDeepStrictEqual({ ...generation.window }, { ...window }) ||
          (scope.phase === "commit" &&
            generation.fingerprint !==
              readSqliteSessionGenerationClaim(database, window).fingerprint)
        );
      })
    ) {
      return false;
    }
  }
  return true;
}

export type SessionDeletionValidation = {
  deleteParams: DeleteSessionEntryLifecycleParams;
  preparedTargetSnapshot: SqliteLifecycleTargetSnapshot;
  scope?: SqliteSessionDeletionScope;
};

export function readValidatedSessionDeletionTarget(
  database: OpenClawAgentDatabase,
  validation: SessionDeletionValidation,
) {
  const snapshot = readLifecycleTargetSnapshot(database, validation.deleteParams.target);
  const entry = snapshot[0]?.entry;
  if (
    !sqliteLifecycleTargetSnapshotsEqual(validation.preparedTargetSnapshot, snapshot) ||
    !shouldDeleteSqliteSessionEntryLifecycle(
      database,
      entry,
      validation.deleteParams,
      validation.scope,
    )
  ) {
    return undefined;
  }
  return { snapshot, entry };
}
