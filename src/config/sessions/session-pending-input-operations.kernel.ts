import { isDeepStrictEqual } from "node:util";
import { MAX_PAYLOAD_BYTES } from "../../gateway/server-constants.js";
import { executeSqliteQuerySync } from "../../infra/kysely-sync.js";
import { getAdmittedSqliteSchemaFacts } from "../../infra/sqlite-schema-facts.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import type { AgentWorkerOperationContext } from "../../state/openclaw-agent-operation-context.js";
import {
  ensureSessionInputCompletionsSchema,
  ensureSessionPendingInputsSchema,
} from "../../state/openclaw-agent-pending-inputs-schema.js";
import { readSessionEntryRow } from "./session-accessor.sqlite-entry-read.js";
import {
  isFinalInputCompletion,
  parseSessionPendingInputMessage,
  readSessionInputCompletion,
  readSessionPendingInputByKey,
  writeSessionInputCompletion,
} from "./session-accessor.sqlite-pending-inputs.js";
import { getSessionKysely } from "./session-accessor.sqlite-scope.js";
import { readTranscriptMessageByScopedIdempotencyKey } from "./session-accessor.sqlite-transcript-store.js";
import { readSessionPendingInputAuthorityFacts } from "./session-pending-input-authority.kernel.js";
import { SessionPendingInputCustodyError } from "./session-pending-input-custody-error.js";
import type {
  PendingInputCustodyGrant,
  PendingInputMutation,
  PendingInputMutationReceipt,
  PendingInputRead,
  PendingInputSnapshot,
} from "./session-pending-input-operations.types.js";
import { readPendingInputSourceInDatabase } from "./session-pending-input-source.kernel.js";

function readPendingInputStage(
  database: OpenClawAgentDatabase,
  input: Extract<PendingInputRead, { kind: "stage" }>,
): PendingInputSnapshot {
  if (readSessionEntryRow(database, input.sessionKey)?.entry.sessionId !== input.sessionId) {
    return { kind: "stage", current: false };
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
    existing: existing ? { ...existing } : undefined,
    previous,
    committed:
      committed && messageJson
        ? { messageId: committed.messageId, message: parseSessionPendingInputMessage(messageJson) }
        : undefined,
  };
}

export function readPendingInput(database: OpenClawAgentDatabase, input: PendingInputRead) {
  return input.kind === "stage"
    ? readPendingInputStage(database, input)
    : readPendingInputSourceInDatabase(database, input);
}

/** Incognito uses this same kernel in its process-held owner until the actor cutover. */
export function mutatePendingInput(
  input: PendingInputMutation,
  { writeTransaction, admit }: Pick<AgentWorkerOperationContext, "writeTransaction" | "admit">,
  publish: (database: OpenClawAgentDatabase["db"], receipt: PendingInputMutationReceipt) => void,
): PendingInputMutationReceipt {
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
      });
      if (!isDeepStrictEqual(snapshot, input.expected)) {
        throw new SessionPendingInputCustodyError("Pending input changed before staging committed");
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
          getSessionKysely(current.db).insertInto("session_pending_inputs").values({
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
          }),
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
