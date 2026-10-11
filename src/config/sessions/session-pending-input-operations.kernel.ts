import { isDeepStrictEqual } from "node:util";
import { MAX_PAYLOAD_BYTES } from "../../gateway/server-constants.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
} from "../../infra/kysely-sync.js";
import {
  sqliteSessionIdWriteScope,
  withoutSqliteDatabaseWriteScope,
  withSqliteDatabaseWriteScope,
} from "../../infra/sqlite-database-admission.js";
import { getAdmittedSqliteSchemaFacts } from "../../infra/sqlite-schema-facts.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import type { AgentWorkerOperationContext } from "../../state/openclaw-agent-operation-context.js";
import {
  ensureSessionInputCompletionsSchema,
  ensureSessionPendingInputsSchema,
} from "../../state/openclaw-agent-pending-inputs-schema.js";
import {
  readSessionEntryIdentity,
  readSessionEntryRow,
} from "./session-accessor.sqlite-entry-read.js";
import {
  readSessionInputCompletion,
  readSessionPendingInputByKey,
  writeSessionInputCompletion,
  type SessionPendingInputRow,
} from "./session-accessor.sqlite-pending-inputs.js";
import { getSessionKysely } from "./session-accessor.sqlite-scope.js";
import { readTranscriptMessageByScopedIdempotencyKey } from "./session-accessor.sqlite-transcript-store.js";
import { readSessionActorTransactionState } from "./session-actor-transaction.js";
import { readSessionPendingInputAuthorityFactsInTransaction } from "./session-pending-input-authority.kernel.js";
import { SessionPendingInputCustodyError } from "./session-pending-input-custody-error.js";
import type {
  PendingInputCustodyGrant,
  PendingInputMutation,
  PendingInputMutationReceipt,
  PendingInputRead,
  PendingInputSnapshot,
} from "./session-pending-input-operations.types.js";
import { readPendingInputSourceInDatabase } from "./session-pending-input-source.kernel.js";
import {
  isFinalInputCompletion,
  parseSessionPendingInputMessage,
} from "./session-pending-input-value.js";

function readPendingInputStage(
  database: OpenClawAgentDatabase,
  input: Extract<PendingInputRead, { kind: "stage" }>,
  existing: SessionPendingInputRow | undefined,
): PendingInputSnapshot {
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
    existing: existing ? { ...existing } : undefined,
    previous,
    committed:
      committed && messageJson
        ? { messageId: committed.messageId, message: parseSessionPendingInputMessage(messageJson) }
        : undefined,
  };
}

export function readPendingInput(database: OpenClawAgentDatabase, input: PendingInputRead) {
  if (input.kind === "source") {
    return readPendingInputSourceInDatabase(database, input);
  }
  if (readSessionEntryIdentity(database, input.sessionKey)?.sessionId !== input.sessionId) {
    return { kind: "stage", current: false } satisfies PendingInputSnapshot;
  }
  return readPendingInputStage(
    database,
    input,
    readSessionPendingInputByKey(database, input, input.idempotencyKey),
  );
}

/** Incognito uses this same kernel in its process-held owner until the actor cutover. */
export function mutatePendingInput(
  input: PendingInputMutation,
  { writeTransaction, admit }: Pick<AgentWorkerOperationContext, "writeTransaction" | "admit">,
  publish: (database: OpenClawAgentDatabase["db"], receipt: PendingInputMutationReceipt) => void,
): PendingInputMutationReceipt {
  return writeTransaction(`session.pending-input.${input.kind}`, "Pending input", (current) =>
    withSqliteDatabaseWriteScope(
      current.db,
      [input.sessionKey, sqliteSessionIdWriteScope(input.sessionId)],
      () => {
        const actor = readSessionActorTransactionState(current, input);
        const row = readSessionPendingInputByKey(current, input, input.idempotencyKey);
        const entry =
          input.kind === "finish"
            ? undefined
            : input.authorityAgentId
              ? readSessionEntryRow(current, input.sessionKey, "list")?.entry
              : readSessionEntryIdentity(current, input.sessionKey);
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
                authority: readSessionPendingInputAuthorityFactsInTransaction(
                  current,
                  input.sessionKey,
                  input.authorityAgentId,
                  new Map([[input.sessionKey, entry]]),
                ),
              }
            : {}),
        };
        if (input.kind !== "finish") {
          if (entry?.sessionId !== input.sessionId) {
            throw new SessionPendingInputCustodyError(
              "Pending input no longer owns the admitted session",
            );
          }
        }
        if (input.kind === "stage") {
          const snapshot = readPendingInputStage(current, input, row);
          if (!isDeepStrictEqual(snapshot, input.expected)) {
            throw new SessionPendingInputCustodyError(
              "Pending input changed before staging committed",
            );
          }
        } else if (
          row &&
          (row.run_id !== input.runId ||
            row.request_hash !== input.requestHash ||
            row.lifecycle_generation !== input.lifecycleGeneration ||
            (input.kind === "finish" && row.input_id !== input.inputId))
        ) {
          throw new SessionPendingInputCustodyError(
            "Pending input settlement lost its accepted owner",
          );
        }
        withoutSqliteDatabaseWriteScope(current.db, () => admit("transaction", grant));
        const schema = getAdmittedSqliteSchemaFacts(current.db);
        if (input.kind === "stage") {
          if (!schema?.tables.has("session_pending_inputs")) {
            ensureSessionPendingInputsSchema(current.db);
          }
          if (input.trackCompletion && !schema?.tables.has("session_input_completions")) {
            ensureSessionInputCompletionsSchema(current.db);
          }
          if (row) {
            receipt.stagedInput = executeSqliteQueryTakeFirstSync(
              current.db,
              getSessionKysely(current.db)
                .updateTable("session_pending_inputs")
                .set({ state: "queued", lifecycle_generation: input.lifecycleGeneration })
                .where("input_id", "=", row.input_id)
                .returningAll(),
            );
          } else {
            receipt.stagedInput = executeSqliteQueryTakeFirstSync(
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
                  accepted_at: Date.now(),
                })
                .returningAll(),
            );
          }
          if (!receipt.stagedInput) {
            throw new SessionPendingInputCustodyError(
              "Pending input staging omitted its postimage",
            );
          }
          actor?.pendingInputs.set(input.idempotencyKey, receipt.stagedInput);
        } else if (input.kind === "complete") {
          if (!schema?.tables.has("session_input_completions")) {
            ensureSessionInputCompletionsSchema(current.db);
          }
          receipt.outcome = writeSessionInputCompletion(current, input, input.outcome);
        } else if (row) {
          const result = executeSqliteQuerySync(
            current.db,
            getSessionKysely(current.db)
              .updateTable("session_pending_inputs")
              .set({ state: input.disposition })
              .where("input_id", "=", input.inputId)
              .where("state", "=", "queued")
              .where("consumed_event_id", "is", null),
          );
          if (input.disposition === "cancelled" && result.numAffectedRows === 1n) {
            receipt.withdrawnInputId = input.inputId;
          }
          if (result.numAffectedRows === 1n) {
            actor?.pendingInputs.set(input.idempotencyKey, { ...row, state: input.disposition });
          }
        }
        withoutSqliteDatabaseWriteScope(current.db, () => {
          publish(current.db, receipt);
          admit("commit", grant);
        });
        return receipt;
      },
    ),
  );
}
