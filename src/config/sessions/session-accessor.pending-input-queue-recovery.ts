import { isDeepStrictEqual } from "node:util";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { selectMainSessionRecoveryCheckpoint } from "../../agents/main-session-recovery/main-session-recovery-checkpoint.js";
import { buildMainSessionRecoveryClearPatch } from "../../agents/main-session-recovery/main-session-recovery-clear.js";
import { executeSqliteQueryTakeFirstSync } from "../../infra/kysely-sync.js";
import { getAdmittedSqliteSchemaFacts } from "../../infra/sqlite-schema-facts.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { resolveSessionWorkStartError } from "./lifecycle.js";
import {
  createMainRestartRecoveryCycle,
  isCapturedMainRestartTurnCurrent,
  type TurnRecoveryIntent,
} from "./main-session-recovery.types.js";
import { buildRestartRecoveryClaimCleanupPatch } from "./restart-recovery-state.js";
import { readSessionEntryRow, writeSessionEntry } from "./session-accessor.sqlite-entry-store.js";
import {
  readPendingInputRecoveryIntent,
  readSessionPendingInputByKey,
  readSessionInputCompletion,
  isFinalInputCompletion,
} from "./session-accessor.sqlite-pending-inputs.js";
import type { SessionPendingInputRow } from "./session-accessor.sqlite-pending-inputs.js";
import { readCurrentProjectionSnapshot } from "./session-accessor.sqlite-projection-read.js";
import {
  iterateVisibleMessageRange,
  resolveVisibleMessagePositions,
} from "./session-accessor.sqlite-reset-window.js";
import {
  getSessionKysely,
  resolveSqliteTranscriptReadScope,
} from "./session-accessor.sqlite-scope.js";
import {
  appendTranscriptEventInTransaction,
  readTranscriptMessageByScopedIdempotencyKey,
} from "./session-accessor.sqlite-transcript-store.js";
import { readCommittedRecoveryInputInDatabase } from "./session-committed-input-recovery.worker.js";
import type {
  PendingInputQueueCandidate,
  CommittedRecoveryInput,
} from "./session-pending-input-operations.types.js";
import type { InternalSessionEntry } from "./types.js";

function canRecoverAcceptedInput(
  entry: InternalSessionEntry,
  sessionId: string,
  sessionKey: string,
  expectedEntry: InternalSessionEntry,
): boolean {
  const state = entry.mainRestartRecovery;
  return !(
    !isDeepStrictEqual(entry, expectedEntry) ||
    entry.sessionId !== sessionId ||
    entry.status !== "interrupted" ||
    entry.abortedLastRun !== true ||
    entry.archivedAt !== undefined ||
    entry.goal?.status !== "paused" ||
    entry.goalPauseOrigin !== "manual" ||
    !state ||
    state.pause ||
    state.acknowledgedPause ||
    state.tombstone ||
    state.reservation ||
    state.capacityWait ||
    state.startedAttempt !== undefined ||
    state.foregroundClaims?.tokens.length ||
    entry.pendingFinalDelivery ||
    entry.restartRecoveryHarnessCompletion ||
    entry.restartRecoveryDeliveryReceiptState ||
    entry.restartRecoveryDeliveryToolCallId ||
    entry.restartRecoveryBeforeAgentReplyState !== undefined ||
    resolveSessionWorkStartError(sessionKey, entry)
  );
}

/** Explicit recovery can admit saved foreground input without resuming a manually paused Goal. */
export function recoverAcceptedPendingInputInDatabase(
  database: OpenClawAgentDatabase,
  target: { sessionKey: string; sessionId: string },
  input: {
    expectedEntry: InternalSessionEntry;
    lifecycleGeneration: string;
    row: PendingInputQueueCandidate;
  },
  fingerprint: (row: SessionPendingInputRow) => string,
): { entry: InternalSessionEntry } | undefined {
  const entry = readSessionEntryRow(database, target.sessionKey)?.entry;
  const state = entry?.mainRestartRecovery;
  if (
    !entry ||
    !state?.queuedInputsPending ||
    !canRecoverAcceptedInput(entry, target.sessionId, target.sessionKey, input.expectedEntry)
  ) {
    return undefined;
  }
  const row = executeSqliteQueryTakeFirstSync(
    database.db,
    getSessionKysely(database.db)
      .selectFrom("session_pending_inputs")
      .selectAll()
      .where("session_key", "=", target.sessionKey)
      .where("session_id", "=", target.sessionId)
      .where("consumed_event_id", "is", null)
      .where("state", "!=", "cancelled")
      .orderBy("seq", "asc")
      .limit(1),
  );
  const capture = row && readPendingInputRecoveryIntent(row);
  if (
    !row ||
    row.input_id !== input.row.input_id ||
    fingerprint(row) !== input.row.rowFingerprint ||
    !capture?.queued ||
    capture.intent.sessionId !== entry.sessionId ||
    capture.intent.lifecycleRevision !== entry.lifecycleRevision ||
    capture.intent.repositoryWorkspaceId !== entry.repositoryWorkspaceId ||
    capture.intent.runId !== row.run_id ||
    capture.intent.inputId !== row.input_id ||
    readTranscriptMessageByScopedIdempotencyKey(
      database,
      { ...target, agentId: database.agentId, path: database.path },
      row.idempotency_key,
      "scan",
    )
  ) {
    return undefined;
  }
  const checkpoint = readCurrentProjectionSnapshot(
    database,
    resolveSqliteTranscriptReadScope({
      ...target,
      agentId: database.agentId,
      storePath: database.path,
    }),
    (projection) =>
      selectMainSessionRecoveryCheckpoint((visit) => {
        for (const item of iterateVisibleMessageRange(
          projection,
          0,
          resolveVisibleMessagePositions(projection).total,
        )) {
          if (isRecord(item.event) && item.event.message !== undefined) {
            visit(item.event.message);
          }
        }
      }),
  );
  if (checkpoint.kind !== "value" || checkpoint.value.unresolvedEffect) {
    return undefined;
  }
  const completion = getAdmittedSqliteSchemaFacts(database.db)?.tables.has(
    "session_input_completions",
  )
    ? readSessionInputCompletion(database, { ...target, idempotencyKey: row.idempotency_key })
    : undefined;
  if (completion && isFinalInputCompletion(completion.outcome)) {
    return undefined;
  }
  return installRecoveredInputHead(
    database,
    target,
    entry,
    capture.intent,
    input.lifecycleGeneration,
    row.input_id,
  );
}

export function recoverCommittedInputInDatabase(
  database: OpenClawAgentDatabase,
  target: { sessionKey: string; sessionId: string },
  input: {
    expectedEntry: InternalSessionEntry;
    lifecycleGeneration: string;
    input: CommittedRecoveryInput;
    intent: TurnRecoveryIntent;
  },
): { entry: InternalSessionEntry } | undefined {
  const entry = readSessionEntryRow(database, target.sessionKey)?.entry;
  const candidate = readCommittedRecoveryInputInDatabase(database, target).input;
  if (
    !entry ||
    !candidate ||
    !canRecoverAcceptedInput(entry, target.sessionId, target.sessionKey, input.expectedEntry) ||
    !isDeepStrictEqual(candidate, input.input) ||
    input.intent.inputId !== candidate.inputId ||
    input.intent.runId !== candidate.runId ||
    input.intent.idempotencyKey !== candidate.idempotencyKey ||
    input.intent.issuer.profileId !== candidate.profileId ||
    input.intent.sessionId !== entry.sessionId ||
    input.intent.sessionKey !== target.sessionKey ||
    input.intent.lifecycleRevision !== entry.lifecycleRevision ||
    input.intent.repositoryWorkspaceId !== entry.repositoryWorkspaceId
  ) {
    return undefined;
  }
  const completion = getAdmittedSqliteSchemaFacts(database.db)?.tables.has(
    "session_input_completions",
  )
    ? readSessionInputCompletion(database, { ...target, idempotencyKey: candidate.idempotencyKey })
    : undefined;
  if (completion && isFinalInputCompletion(completion.outcome)) {
    return undefined;
  }
  const checkpoint = readCurrentProjectionSnapshot(
    database,
    resolveSqliteTranscriptReadScope({
      ...target,
      agentId: database.agentId,
      storePath: database.path,
    }),
    (projection) =>
      selectMainSessionRecoveryCheckpoint((visit) => {
        for (const item of iterateVisibleMessageRange(
          projection,
          0,
          resolveVisibleMessagePositions(projection).total,
        )) {
          if (isRecord(item.event) && item.event.message !== undefined) {
            visit(item.event.message);
          }
        }
      }),
  );
  if (checkpoint.kind !== "value" || checkpoint.value.unresolvedEffect) {
    return undefined;
  }
  return installRecoveredInputHead(
    database,
    target,
    entry,
    input.intent,
    input.lifecycleGeneration,
    input.intent.inputId,
  );
}

function installRecoveredInputHead(
  database: OpenClawAgentDatabase,
  target: { sessionKey: string; sessionId: string },
  entry: InternalSessionEntry,
  intent: TurnRecoveryIntent,
  lifecycleGeneration: string,
  queuedInputId?: string,
): { entry: InternalSessionEntry } {
  const predecessor = entry.mainRestartRecovery?.turnIntent;
  if (predecessor && !isDeepStrictEqual(predecessor, intent)) {
    appendTranscriptEventInTransaction(
      database,
      { ...target, agentId: database.agentId, path: database.path },
      {
        type: "custom",
        id: `restart-recovery-unresolved:${predecessor.inputId}`,
        timestamp: new Date().toISOString(),
        customType: "restart-recovery-unresolved-input",
        data: { intent: predecessor, disposition: "unresolved" },
      },
    );
  }
  const next = writeSessionEntry(
    database,
    target.sessionKey,
    {
      ...entry,
      ...buildRestartRecoveryClaimCleanupPatch({ entry, recordTerminalSource: false }),
      restartRecoveryForceSafeTools: entry.restartRecoveryForceSafeTools,
      restartRecoveryDeliveryRunId: intent.runId,
      restartRecoveryDeliverySourceRunId: intent.runId,
      restartRecoveryRuns: [{ runId: intent.runId, lifecycleGeneration }],
      mainRestartRecovery: {
        ...createMainRestartRecoveryCycle(),
        ...(entry.mainRestartRecovery?.goalIntent
          ? { goalIntent: entry.mainRestartRecovery?.goalIntent }
          : {}),
        turnIntent: intent,
        queuedInputId,
        queuedInputsPending: queuedInputId ? true : entry.mainRestartRecovery?.queuedInputsPending,
      },
    },
    { canonicalPreviousEntry: entry },
  );
  return { entry: next };
}

/** The existing row order chooses one unstarted follower only after the previous owner settles. */
export function promoteQueuedPendingInputInDatabase(
  database: OpenClawAgentDatabase,
  target: { sessionKey: string; sessionId: string },
  input: { expectedEntry: InternalSessionEntry; lifecycleGeneration: string },
): { entry: InternalSessionEntry } | undefined {
  const entry = readSessionEntryRow(database, target.sessionKey)?.entry;
  const state = entry?.mainRestartRecovery;
  const current = state?.queuedInputId
    ? executeSqliteQueryTakeFirstSync(
        database.db,
        getSessionKysely(database.db)
          .selectFrom("session_pending_inputs")
          .selectAll()
          .where("session_key", "=", target.sessionKey)
          .where("session_id", "=", target.sessionId)
          .where("input_id", "=", state.queuedInputId),
      )
    : undefined;
  const cancelledHead =
    current?.input_id === state?.queuedInputId && current?.state === "cancelled";
  if (
    !entry ||
    !isDeepStrictEqual(entry, input.expectedEntry) ||
    entry.sessionId !== target.sessionId ||
    entry.archivedAt !== undefined ||
    state?.pause ||
    state?.tombstone ||
    state?.reservation ||
    (state?.foregroundClaims?.lifecycleGeneration === input.lifecycleGeneration &&
      state.foregroundClaims.tokens.length) ||
    !state?.queuedInputsPending ||
    resolveSessionWorkStartError(target.sessionKey, entry) ||
    (entry.goal && entry.goal.status !== "active")
  ) {
    return undefined;
  }
  const turn = state.turnIntent;
  if (isCapturedMainRestartTurnCurrent(entry) && !cancelledHead) {
    // A later authenticated foreground acceptance can replace an unissued legacy head.
    // Repair its stale source pointer only; neither input nor its issuer is transferred.
    if (
      entry.abortedLastRun !== true ||
      !turn ||
      turn.lifecycleGeneration === input.lifecycleGeneration ||
      turn.sessionKey !== target.sessionKey ||
      turn.repositoryWorkspaceId !== entry.repositoryWorkspaceId ||
      current?.input_id === turn.inputId ||
      current?.state !== "interrupted" ||
      current.consumed_event_id !== null ||
      current.recovery_intent_json !== null ||
      entry.restartRecoveryDeliveryRunId !== current.run_id ||
      entry.restartRecoveryDeliverySourceRunId !== current.run_id ||
      entry.restartRecoveryDeliveryReceiptState ||
      entry.restartRecoveryDeliveryToolCallId ||
      entry.restartRecoveryBeforeAgentReplyState !== undefined ||
      entry.pendingFinalDelivery ||
      entry.restartRecoveryHarnessCompletion
    ) {
      return undefined;
    }
    const pending = readSessionPendingInputByKey(database, target, turn.idempotencyKey);
    const committed = pending
      ? undefined
      : readTranscriptMessageByScopedIdempotencyKey(
          database,
          {
            ...target,
            agentId: database.agentId,
            path: database.path,
          },
          turn.idempotencyKey,
          "scan",
        );
    if (
      pending
        ? pending.input_id !== turn.inputId ||
          pending.run_id !== turn.runId ||
          pending.state === "cancelled" ||
          !isDeepStrictEqual(readPendingInputRecoveryIntent(pending)?.intent, turn)
        : committed?.messageId !== turn.inputId ||
          !isRecord(committed.message) ||
          committed.message.role !== "user"
    ) {
      return undefined;
    }
    const next = writeSessionEntry(
      database,
      target.sessionKey,
      {
        ...entry,
        ...buildRestartRecoveryClaimCleanupPatch({ entry, recordTerminalSource: false }),
        restartRecoveryForceSafeTools: entry.restartRecoveryForceSafeTools,
        mainRestartRecovery: { ...state, revision: state.revision + 1, queuedInputId: undefined },
      },
      { canonicalPreviousEntry: entry },
    );
    return { entry: next };
  }
  if (entry.status !== "done" && !cancelledHead) {
    return undefined;
  }
  const row = executeSqliteQueryTakeFirstSync(
    database.db,
    getSessionKysely(database.db)
      .selectFrom("session_pending_inputs")
      .selectAll()
      .where("session_key", "=", target.sessionKey)
      .where("session_id", "=", target.sessionId)
      .where("consumed_event_id", "is", null)
      .where("state", "!=", "cancelled")
      .orderBy("seq", "asc")
      .limit(1),
  );
  const capture = row && readPendingInputRecoveryIntent(row);
  if (!row) {
    const settled = {
      ...entry,
      mainRestartRecovery: { ...state!, queuedInputsPending: undefined },
    };
    if (cancelledHead) {
      settled.status = "done";
      Object.assign(
        settled,
        buildRestartRecoveryClaimCleanupPatch({
          entry: settled,
          recordTerminalSource: true,
          terminalRunId: current!.run_id,
          terminalSourceRunId: current!.run_id,
        }),
      );
    }
    Object.assign(settled, buildMainSessionRecoveryClearPatch(settled));
    const next = writeSessionEntry(database, target.sessionKey, settled, {
      canonicalPreviousEntry: entry,
    });
    return { entry: next };
  }
  if (row.lifecycle_generation === input.lifecycleGeneration) {
    return undefined;
  }
  const intent =
    capture?.queued &&
    capture.intent.lifecycleRevision === entry.lifecycleRevision &&
    capture.intent.repositoryWorkspaceId === entry.repositoryWorkspaceId
      ? capture.intent
      : undefined;
  const next = writeSessionEntry(
    database,
    target.sessionKey,
    {
      ...entry,
      status: "interrupted",
      abortedLastRun: true,
      restartRecoveryGoal: undefined,
      restartRecoveryDeliveryRunId: row.run_id,
      restartRecoveryDeliverySourceRunId: row.run_id,
      restartRecoveryRuns: [{ runId: row.run_id, lifecycleGeneration: row.lifecycle_generation }],
      mainRestartRecovery: {
        ...createMainRestartRecoveryCycle(),
        ...(state?.goalIntent ? { goalIntent: state.goalIntent } : {}),
        turnIntent: intent,
        queuedInputId: row.input_id,
        queuedInputsPending: true,
      },
    },
    { canonicalPreviousEntry: entry },
  );
  return { entry: next };
}
