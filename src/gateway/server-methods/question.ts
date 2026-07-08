// Gateway question methods: list visible pending questions and resolve one from
// any surface. A process-global QuestionManager holds the promise that parks the
// asking tool; these handlers resolve it and the manager's emitter broadcasts the
// pending/resolved/expired lifecycle events that Control UI and channels render.
import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  validateQuestionListParams,
  validateQuestionResolveParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { ADMIN_SCOPE, APPROVALS_SCOPE } from "../method-scopes.js";
import type {
  QuestionAnswers,
  QuestionEmitter,
  QuestionManager,
  QuestionRecord,
} from "../question-manager.js";
import type { GatewayClient, GatewayRequestHandlers } from "./types.js";

/** Broadcast fn shape shared with the rest of the gateway server. */
export type QuestionBroadcast = (
  event: string,
  payload: unknown,
  opts?: { dropIfSlow?: boolean },
) => void;

/**
 * A pending question is visible to admin-scope operator clients (Control UI) and
 * to approvals-scope clients. Turn-source-scoped visibility for non-admin channel
 * clients is enforced at the channel layer, which filters the broadcast events by
 * `turnSourceChannel`.
 */
export function isQuestionVisibleToClient(params: {
  record: QuestionRecord;
  client: GatewayClient | null;
}): boolean {
  const scopes = Array.isArray(params.client?.connect?.scopes) ? params.client.connect.scopes : [];
  return scopes.includes(ADMIN_SCOPE) || scopes.includes(APPROVALS_SCOPE);
}

/** Serializable pending-question shape returned by question.list and broadcast on pending. */
export function toQuestionListEntry(record: QuestionRecord) {
  return {
    id: record.id,
    sessionKey: record.sessionKey ?? null,
    agentId: record.agentId ?? null,
    turnSourceChannel: record.turnSourceChannel ?? null,
    turnSourceTo: record.turnSourceTo ?? null,
    turnSourceAccountId: record.turnSourceAccountId ?? null,
    turnSourceThreadId: record.turnSourceThreadId ?? null,
    createdAtMs: record.createdAtMs,
    expiresAtMs: record.expiresAtMs ?? null,
    questions: record.questions,
  };
}

/** Builds the manager emitter that broadcasts the pending/resolved/expired events. */
export function createQuestionEmitter(broadcast: QuestionBroadcast): QuestionEmitter {
  return {
    onPending: (record) => {
      broadcast("question.pending", toQuestionListEntry(record), { dropIfSlow: true });
    },
    onResolved: (record, answers) => {
      broadcast(
        "question.resolved",
        {
          id: record.id,
          answers,
          resolvedBy: record.resolvedBy ?? null,
          ts: record.resolvedAtMs ?? Date.now(),
          turnSourceChannel: record.turnSourceChannel ?? null,
          turnSourceAccountId: record.turnSourceAccountId ?? null,
        },
        { dropIfSlow: true },
      );
    },
    onExpired: (record, reason) => {
      broadcast(
        "question.expired",
        {
          id: record.id,
          reason,
          ts: record.resolvedAtMs ?? Date.now(),
          turnSourceChannel: record.turnSourceChannel ?? null,
          turnSourceAccountId: record.turnSourceAccountId ?? null,
        },
        { dropIfSlow: true },
      );
    },
  };
}

/** Binds the global manager emitter to the gateway broadcast (call once at startup). */
export function bindQuestionManagerEmitter(params: {
  manager: QuestionManager;
  broadcast: QuestionBroadcast;
}): void {
  params.manager.setEmitter(createQuestionEmitter(params.broadcast));
}

/** Creates the question.list and question.resolve gateway handlers. */
export function createQuestionHandlers(manager: QuestionManager): GatewayRequestHandlers {
  return {
    "question.list": async ({ params, respond, client }) => {
      if (!validateQuestionListParams(params)) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            `invalid question.list params: ${formatValidationErrors(
              validateQuestionListParams.errors,
            )}`,
          ),
        );
        return;
      }
      const records = manager.list((record) => isQuestionVisibleToClient({ record, client }));
      respond(true, { questions: records.map(toQuestionListEntry) }, undefined);
    },
    "question.resolve": async ({ params, respond, client }) => {
      if (!validateQuestionResolveParams(params)) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            `invalid question.resolve params: ${formatValidationErrors(
              validateQuestionResolveParams.errors,
            )}`,
          ),
        );
        return;
      }
      const p = params as { id: string; answers: QuestionAnswers };
      const snapshot = manager.getSnapshot(p.id);
      if (!snapshot || snapshot.status !== "pending") {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, "unknown or already-resolved question id", {
            details: { reason: "QUESTION_NOT_FOUND" },
          }),
        );
        return;
      }
      if (!isQuestionVisibleToClient({ record: snapshot, client })) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, "unknown or already-resolved question id", {
            details: { reason: "QUESTION_NOT_FOUND" },
          }),
        );
        return;
      }
      const resolvedBy =
        client?.connect?.client?.displayName ?? client?.connect?.client?.id ?? null;
      const ok = manager.resolve(p.id, p.answers, resolvedBy);
      if (!ok) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, "question already resolved", {
            details: { reason: "QUESTION_ALREADY_RESOLVED" },
          }),
        );
        return;
      }
      respond(true, { ok: true }, undefined);
    },
  };
}
