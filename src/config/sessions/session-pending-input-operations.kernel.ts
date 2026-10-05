import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { transitionMainSessionRecovery } from "../../agents/main-session-recovery/main-session-recovery-state.js";
import { MAX_PAYLOAD_BYTES } from "../../gateway/server-constants.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
} from "../../infra/kysely-sync.js";
import { getAdmittedSqliteSchemaFacts } from "../../infra/sqlite-schema-facts.js";
import { runSqliteDeferredTransactionSync } from "../../infra/sqlite-transaction.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import {
  ensureSessionGoalOperationsSchema,
  SESSION_GOAL_OPERATIONS_TABLE,
} from "../../state/openclaw-agent-goal-operations-schema.js";
import type { AgentWorkerOperationContext } from "../../state/openclaw-agent-operation-context.js";
import {
  ensureSessionInputCompletionsSchema,
  ensureSessionPendingInputsSchema,
} from "../../state/openclaw-agent-pending-inputs-schema.js";
import {
  applySessionGoalOperation,
  assertSessionGoalOperationTime,
  readSessionGoalOperationReceipt,
  writeSessionGoalOperationReceipt,
  SessionGoalOperationError,
} from "./goals-operations.js";
import {
  createMainRestartRecoveryCycle,
  isCapturedMainRestartTurnCurrent,
  isGoalRecoveryDecisionCurrent,
} from "./main-session-recovery.types.js";
import {
  promoteQueuedPendingInputInDatabase,
  recoverAcceptedPendingInputInDatabase,
  recoverCommittedInputInDatabase,
} from "./session-accessor.pending-input-queue-recovery.js";
import { readSessionEntryRow } from "./session-accessor.sqlite-entry-read.js";
import { writeSessionEntry } from "./session-accessor.sqlite-entry-store.js";
import {
  isFinalInputCompletion,
  parseSessionPendingInputMessage,
  readSessionInputCompletion,
  readSessionPendingInputByKey,
  writeSessionInputCompletion,
  readPendingInputRecoveryIntent,
  type SessionPendingInputRow,
} from "./session-accessor.sqlite-pending-inputs.js";
import { prepareSessionEntryReplacementPublication } from "./session-accessor.sqlite-replacement-state.js";
import { getSessionKysely } from "./session-accessor.sqlite-scope.js";
import { readTranscriptMessageByScopedIdempotencyKey } from "./session-accessor.sqlite-transcript-store.js";
import { readCommittedRecoveryInputInDatabase } from "./session-committed-input-recovery.worker.js";
import { readSessionPendingInputAuthorityFacts } from "./session-pending-input-authority.kernel.js";
import { SessionPendingInputCustodyError } from "./session-pending-input-custody-error.js";
import type {
  PendingInputCustodyGrant,
  PendingInputMutation,
  PendingInputMutationReceipt,
  PendingInputRead,
  PendingInputSnapshot,
  PendingInputQueueSnapshot,
  PendingInputQueueMutation,
} from "./session-pending-input-operations.types.js";
import { readPendingInputSourceInDatabase } from "./session-pending-input-source.kernel.js";

function readPendingInputStage(
  database: OpenClawAgentDatabase,
  input: Extract<PendingInputRead, { kind: "stage" }>,
): PendingInputSnapshot {
  const entry = readSessionEntryRow(database, input.sessionKey)?.entry;
  if (entry?.sessionId !== input.sessionId) {
    return { kind: "stage", current: false };
  }
  if (input.goalOperation) {
    assertSessionGoalOperationTime(input.goalOperation, Date.now());
  }
  const existing = readSessionPendingInputByKey(database, input, input.idempotencyKey);
  const previous =
    input.trackCompletion &&
    getAdmittedSqliteSchemaFacts(database.db)?.tables.has("session_input_completions")
      ? readSessionInputCompletion(database, input)
      : undefined;
  const committed =
    existing?.consumed_event_id != null || (previous && isFinalInputCompletion(previous.outcome))
      ? undefined
      : readTranscriptMessageByScopedIdempotencyKey(
          database,
          { ...input, agentId: database.agentId, path: database.path },
          input.idempotencyKey,
          "scan",
        );
  const messageJson = committed ? JSON.stringify(committed.message) : undefined;
  if (
    (existing && Buffer.byteLength(existing.message_json, "utf8") > MAX_PAYLOAD_BYTES) ||
    (messageJson && Buffer.byteLength(messageJson, "utf8") > MAX_PAYLOAD_BYTES)
  ) {
    throw new Error("Pending input exceeds the Gateway payload limit");
  }
  return {
    kind: "stage",
    current: true,
    entry,
    goalReceipt:
      input.goalOperation &&
      getAdmittedSqliteSchemaFacts(database.db)?.tables.has(SESSION_GOAL_OPERATIONS_TABLE)
        ? readSessionGoalOperationReceipt(
            database.db,
            input.sessionKey,
            input.sessionId,
            input.goalOperation,
          )
        : undefined,
    existing: existing ? { ...existing } : undefined,
    previous,
    committed:
      committed && messageJson
        ? { messageId: committed.messageId, message: parseSessionPendingInputMessage(messageJson) }
        : undefined,
  };
}

export function readPendingInput(database: OpenClawAgentDatabase, input: PendingInputRead) {
  if (input.kind === "committed-recovery") {
    return readCommittedRecoveryInputInDatabase(database, input);
  }
  return input.kind === "queue"
    ? runSqliteDeferredTransactionSync(database.db, () => readPendingInputQueue(database, input))
    : input.kind === "stage"
      ? runSqliteDeferredTransactionSync(database.db, () => readPendingInputStage(database, input))
      : readPendingInputSourceInDatabase(database, input);
}

function readPendingInputQueue(
  database: OpenClawAgentDatabase,
  input: Extract<PendingInputRead, { kind: "queue" }>,
): PendingInputQueueSnapshot {
  const entry = readSessionEntryRow(database, input.sessionKey)?.entry;
  if (
    entry?.sessionId !== input.sessionId ||
    !getAdmittedSqliteSchemaFacts(database.db)?.tables.has("session_pending_inputs")
  ) {
    return {
      kind: "queue",
      current: entry?.sessionId === input.sessionId,
      entry,
      rows: [],
      throughSeq: input.throughSeq ?? 0,
    };
  }
  const throughSeq =
    input.throughSeq ??
    executeSqliteQueryTakeFirstSync(
      database.db,
      getSessionKysely(database.db)
        .selectFrom("session_pending_inputs")
        .select(({ fn }) => fn.max<number>("seq").as("seq"))
        .where("session_key", "=", input.sessionKey)
        .where("session_id", "=", input.sessionId),
    )?.seq ??
    0;
  let query = getSessionKysely(database.db)
    .selectFrom("session_pending_inputs")
    .selectAll()
    .where("session_key", "=", input.sessionKey)
    .where("session_id", "=", input.sessionId)
    .where("consumed_event_id", "is", null)
    .where("state", "!=", "cancelled")
    .where("seq", ">", input.afterSeq ?? 0)
    .where("seq", "<=", throughSeq)
    .orderBy("seq", "asc")
    .limit(input.runId ? 1 : 20);
  if (input.runId) {
    query = query.where("run_id", "=", input.runId).limit(1);
  }
  const rows = executeSqliteQuerySync(database.db, query).rows.map((row) => {
    const capture = readPendingInputRecoveryIntent(row);
    const deviceId = capture?.intent.issuer.device?.deviceId;
    return {
      seq: row.seq,
      input_id: row.input_id,
      session_key: row.session_key,
      session_id: row.session_id,
      idempotency_key: row.idempotency_key,
      run_id: row.run_id,
      lifecycle_generation: row.lifecycle_generation,
      state: row.state,
      rowFingerprint: pendingInputRowFingerprint(row),
      ownerDeviceId: typeof deviceId === "string" ? deviceId : undefined,
    };
  });
  return {
    kind: "queue",
    current: true,
    entry,
    rows,
    row: input.runId ? rows[0] : undefined,
    throughSeq,
    nextAfterSeq: !input.runId && rows.length === 20 ? rows.at(-1)?.seq : undefined,
  };
}

function pendingInputRowFingerprint(row: SessionPendingInputRow): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        row.seq,
        row.input_id,
        row.session_key,
        row.session_id,
        row.idempotency_key,
        row.run_id,
        row.request_hash,
        row.message_json,
        row.lifecycle_generation,
        row.state,
        row.accepted_at,
        row.consumed_event_id ?? null,
        row.recovery_intent_json ?? null,
      ]),
    )
    .digest("hex");
}

/** Incognito uses this same kernel in its process-held owner until the actor cutover. */
export function mutatePendingInput(
  input: PendingInputMutation,
  { writeTransaction, admit }: Pick<AgentWorkerOperationContext, "writeTransaction" | "admit">,
  publish: (database: OpenClawAgentDatabase["db"], receipt: PendingInputMutationReceipt) => void,
): PendingInputMutationReceipt {
  if (
    input.kind === "promote" ||
    input.kind === "cancel-queued" ||
    input.kind === "recover-accepted" ||
    input.kind === "recover-committed"
  ) {
    return mutatePendingInputQueue(input, { writeTransaction, admit }, publish);
  }
  return writeTransaction(`session.pending-input.${input.kind}`, "Pending input", (current) => {
    const row = readSessionPendingInputByKey(current, input, input.idempotencyKey);
    const receipt: PendingInputMutationReceipt = {
      kind: "pending-input-settlement",
      operation: input.kind,
      sessionKey: input.sessionKey,
      sessionId: input.sessionId,
      idempotencyKey: input.idempotencyKey,
      runId: input.runId,
      requestHash: input.requestHash,
      lifecycleGeneration: input.lifecycleGeneration,
    };
    const grant: PendingInputCustodyGrant = {
      kind: "pending-input-settlement-custody",
      candidate: row,
      receipt,
      ...(input.kind !== "finish" && input.authorityAgentId
        ? {
            authority: readSessionPendingInputAuthorityFacts(
              current,
              input.sessionKey,
              input.authorityAgentId,
            ),
          }
        : {}),
    };
    if (input.kind !== "finish") {
      if (readSessionEntryRow(current, input.sessionKey)?.entry.sessionId !== input.sessionId) {
        throw new SessionPendingInputCustodyError(
          "Pending input no longer owns the admitted session",
        );
      }
    }
    if (input.kind === "stage") {
      const snapshot = readPendingInputStage(current, {
        ...input,
        kind: "stage",
        goalOperation: input.goalRecovery?.operation,
      });
      if (!isDeepStrictEqual(snapshot, input.expected)) {
        throw new SessionPendingInputCustodyError("Pending input changed before staging committed");
      }
      const entry = snapshot.entry;
      const turn = input.turnIntent;
      if (
        turn &&
        (!entry ||
          turn.sessionId !== input.sessionId ||
          turn.sessionKey !== input.sessionKey ||
          turn.lifecycleRevision !== entry.lifecycleRevision ||
          turn.runId !== input.runId ||
          turn.inputId !== input.inputId ||
          turn.idempotencyKey !== input.idempotencyKey ||
          (!input.expected.existing && turn.lifecycleGeneration !== input.lifecycleGeneration))
      ) {
        throw new SessionPendingInputCustodyError(
          "Accepted turn differs from its original input custody",
        );
      }
      const goalRecovery = input.goalRecovery;
      if (
        goalRecovery &&
        (!entry ||
          !turn ||
          goalRecovery.intent.goalId !== goalRecovery.operation.goalId ||
          goalRecovery.intent.sessionId !== entry.sessionId ||
          goalRecovery.intent.sessionKey !== input.sessionKey ||
          goalRecovery.intent.lifecycleRevision !== entry.lifecycleRevision ||
          !isDeepStrictEqual(goalRecovery.intent.issuer, turn.issuer) ||
          !isGoalRecoveryDecisionCurrent(entry, {
            ...goalRecovery.decision,
            assertCurrent: () => admit("transaction", grant),
          }))
      ) {
        throw new SessionGoalOperationError(
          "recovery-decision-changed",
          "Goal recovery acceptance changed before commit.",
        );
      }
    } else if (
      row &&
      (row.run_id !== input.runId ||
        row.request_hash !== input.requestHash ||
        row.lifecycle_generation !== input.lifecycleGeneration ||
        (input.kind === "finish" && row.input_id !== input.inputId))
    ) {
      throw new SessionPendingInputCustodyError("Pending input settlement lost its accepted owner");
    }
    admit("transaction", grant);
    const schema = getAdmittedSqliteSchemaFacts(current.db);
    if (input.kind === "stage") {
      const now = Date.now();
      const entry = input.expected.entry;
      const turnIntent = input.turnIntent;
      const goalRecovery = input.goalRecovery;
      const queued = Boolean(
        turnIntent &&
        entry &&
        isCapturedMainRestartTurnCurrent(entry) &&
        entry.mainRestartRecovery?.turnIntent?.runId !== input.runId,
      );
      const replaceTurnIntent = Boolean(
        turnIntent &&
        entry &&
        (goalRecovery ||
          !isCapturedMainRestartTurnCurrent(entry) ||
          entry.mainRestartRecovery?.turnIntent?.runId === input.runId),
      );
      if (!schema?.tables.has("session_pending_inputs")) {
        ensureSessionPendingInputsSchema(current.db);
      }
      if (input.trackCompletion && !schema?.tables.has("session_input_completions")) {
        ensureSessionInputCompletionsSchema(current.db);
      }
      if (row) {
        executeSqliteQuerySync(
          current.db,
          getSessionKysely(current.db)
            .updateTable("session_pending_inputs")
            .set({ state: "queued", lifecycle_generation: input.lifecycleGeneration })
            .where("input_id", "=", row.input_id),
        );
      } else {
        executeSqliteQuerySync(
          current.db,
          getSessionKysely(current.db)
            .insertInto("session_pending_inputs")
            .values({
              input_id: input.inputId,
              session_key: input.sessionKey,
              session_id: input.sessionId,
              idempotency_key: input.idempotencyKey,
              run_id: input.runId,
              request_hash: input.requestHash,
              message_json: input.messageJson,
              lifecycle_generation: input.lifecycleGeneration,
              state: "queued",
              accepted_at: now,
              recovery_intent_json: turnIntent
                ? JSON.stringify({
                    version: 1,
                    intent: turnIntent,
                    requestHash: input.requestHash,
                    messageHash: createHash("sha256").update(input.messageJson).digest("hex"),
                    queued,
                  })
                : null,
            }),
        );
      }
      if (entry && turnIntent && (replaceTurnIntent || queued)) {
        const next = { ...entry };
        if (goalRecovery) {
          if (!schema?.tables.has(SESSION_GOAL_OPERATIONS_TABLE)) {
            ensureSessionGoalOperationsSchema(current.db);
          }
          const transition = transitionMainSessionRecovery(next, {
            kind: "acknowledge_pause",
            now,
            observation: {
              sessionId: goalRecovery.decision.sessionId,
              cycleId: goalRecovery.decision.reference.cycleId,
              revision: goalRecovery.decision.reference.revision,
            },
          });
          if (transition.kind !== "applied") {
            throw new SessionGoalOperationError(
              "recovery-decision-changed",
              "The reviewed recovery hold changed before acceptance.",
            );
          }
          next.goal = applySessionGoalOperation(next, goalRecovery.operation, now);
          next.goalPauseOrigin = undefined;
          next.restartRecoveryGoal = {
            id: goalRecovery.operation.goalId,
            sessionId: entry.sessionId,
            lifecycleRevision: entry.lifecycleRevision,
            capturedAtMs: now,
          };
          next.restartRecoveryDeliverySourceRunId =
            entry.restartRecoveryDeliverySourceRunId ?? entry.lifecycleRunId;
          next.restartRecoveryDeliveryRunId = input.runId;
        }
        const changed = writeSessionEntry(
          current,
          input.sessionKey,
          {
            ...next,
            mainRestartRecovery: {
              ...(next.mainRestartRecovery ?? createMainRestartRecoveryCycle()),
              ...(replaceTurnIntent ? { turnIntent } : {}),
              ...(queued ? { queuedInputsPending: true as const } : {}),
              ...(goalRecovery ? { goalIntent: goalRecovery.intent } : {}),
            },
          },
          { canonicalPreviousEntry: entry },
        );
        if (goalRecovery) {
          receipt.goalOperation = {
            result: writeSessionGoalOperationReceipt(
              current.db,
              input.sessionKey,
              input.sessionId,
              goalRecovery.operation,
              changed.goal,
              input.runId,
            ),
            replayed: false,
          };
        }
        receipt.publication = prepareSessionEntryReplacementPublication(
          {
            previous: new Map([[input.sessionKey, entry]]),
            current: new Map([[input.sessionKey, changed]]),
            pendingArchiveRecovery: false,
            membershipInvalidatedKeys: [],
            maintenancePlans: [],
          },
          current,
        );
      }
    } else if (input.kind === "complete") {
      if (!schema?.tables.has("session_input_completions")) {
        ensureSessionInputCompletionsSchema(current.db);
      }
      const previous = readSessionInputCompletion(current, input);
      if (
        previous &&
        (previous.run_id !== input.runId || previous.request_hash !== input.requestHash)
      ) {
        throw new SessionPendingInputCustodyError(
          "Input completion conflicts with the accepted input",
        );
      }
      receipt.outcome = writeSessionInputCompletion(current, input, input.outcome);
    } else if (row) {
      executeSqliteQuerySync(
        current.db,
        getSessionKysely(current.db)
          .updateTable("session_pending_inputs")
          .set({ state: input.disposition })
          .where("input_id", "=", input.inputId)
          .where("state", "=", "queued")
          .where("consumed_event_id", "is", null),
      );
    }
    publish(current.db, receipt);
    admit("commit", grant);
    return receipt;
  });
}

function mutatePendingInputQueue(
  input: PendingInputQueueMutation,
  { writeTransaction, admit }: Pick<AgentWorkerOperationContext, "writeTransaction" | "admit">,
  publish: (database: OpenClawAgentDatabase["db"], receipt: PendingInputMutationReceipt) => void,
): PendingInputMutationReceipt {
  return writeTransaction(
    `session.pending-input.${input.kind}`,
    "Pending input queue",
    (current) => {
      const receipt: Extract<
        PendingInputMutationReceipt,
        { operation: "promote" | "cancel-queued" | "recover-accepted" | "recover-committed" }
      > = {
        kind: "pending-input-settlement",
        operation: input.kind,
        sessionKey: input.sessionKey,
        sessionId: input.sessionId,
        lifecycleGeneration: input.lifecycleGeneration,
        changed: false,
      };
      const previous = readSessionEntryRow(current, input.sessionKey)?.entry;
      const row =
        input.kind === "cancel-queued"
          ? readSessionPendingInputByKey(current, input, input.row.idempotency_key)
          : undefined;
      const grant: PendingInputCustodyGrant = {
        kind: "pending-input-settlement-custody",
        receipt,
      };
      admit("transaction", grant);
      if (
        previous?.sessionId === input.sessionId &&
        isDeepStrictEqual(previous, input.expectedEntry) &&
        getAdmittedSqliteSchemaFacts(current.db)?.tables.has("session_pending_inputs")
      ) {
        if (input.kind === "cancel-queued") {
          if (
            row &&
            row.input_id === input.row.input_id &&
            pendingInputRowFingerprint(row) === input.row.rowFingerprint &&
            row.consumed_event_id == null &&
            row.state !== "cancelled"
          ) {
            const result = executeSqliteQuerySync(
              current.db,
              getSessionKysely(current.db)
                .updateTable("session_pending_inputs")
                .set({ state: "cancelled" })
                .where("input_id", "=", row.input_id)
                .where("consumed_event_id", "is", null),
            );
            receipt.changed = result.numAffectedRows === 1n;
          }
        } else {
          const promoted =
            input.kind === "recover-committed"
              ? recoverCommittedInputInDatabase(current, input, input)
              : input.kind === "recover-accepted"
                ? recoverAcceptedPendingInputInDatabase(
                    current,
                    input,
                    input,
                    pendingInputRowFingerprint,
                  )
                : promoteQueuedPendingInputInDatabase(current, input, input);
          if (promoted) {
            receipt.changed = true;
            receipt.entry = promoted.entry;
            receipt.publication = prepareSessionEntryReplacementPublication(
              {
                previous: new Map([[input.sessionKey, previous]]),
                current: new Map([[input.sessionKey, promoted.entry]]),
                pendingArchiveRecovery: false,
                membershipInvalidatedKeys: [],
                maintenancePlans: [],
              },
              current,
            );
          }
        }
      }
      publish(current.db, receipt);
      admit("commit", grant);
      return receipt;
    },
  );
}
