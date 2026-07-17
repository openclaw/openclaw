/** Built-in blocking user-question tool and its active-session answer bridge. */
import { createHash } from "node:crypto";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { Type } from "typebox";
import type {
  QuestionAnswers,
  QuestionRequestQuestion,
  QuestionWaitAnswerResult,
} from "../../../packages/gateway-protocol/src/index.js";
import {
  buildAgentHarnessUserInputAnswers,
  type AgentHarnessUserInputQuestion,
} from "../harness/user-input-bridge.js";
import { ASK_USER_TOOL_DISPLAY_SUMMARY, describeAskUserTool } from "../tool-description-presets.js";
import { type AnyAgentTool, ToolInputError, textResult } from "./common.js";
import { callGatewayTool, type GatewayCallOptions } from "./gateway.js";

const DEFAULT_ASK_USER_TIMEOUT_SECONDS = 900;
const MIN_ASK_USER_TIMEOUT_SECONDS = 30;
const MAX_ASK_USER_TIMEOUT_SECONDS = 3600;
const ASK_USER_RPC_GRACE_MS = 10_000;
const QUESTION_ID_PATTERN = /^[a-z][a-z0-9_]*$/;
const TERMINAL_QUESTION_ERROR_REASONS = new Set([
  "QUESTION_ALREADY_TERMINAL",
  "QUESTION_NOT_FOUND",
]);

const AskUserToolSchema = Type.Object(
  {
    questions: Type.Array(
      Type.Object(
        {
          id: Type.String({
            minLength: 1,
            pattern: "^[a-z][a-z0-9_]*$",
            description: "Unique snake_case answer key.",
          }),
          header: Type.String({
            minLength: 1,
            description: "Short chip label; longer input is truncated to 12 characters.",
          }),
          question: Type.String({
            minLength: 1,
            description: "Single-sentence question for the user.",
          }),
          options: Type.Array(
            Type.Object(
              {
                label: Type.String({ minLength: 1 }),
                description: Type.Optional(Type.String()),
              },
              { additionalProperties: false },
            ),
            { minItems: 2, maxItems: 4 },
          ),
          multiSelect: Type.Optional(Type.Boolean()),
        },
        { additionalProperties: false },
      ),
      { minItems: 1, maxItems: 3 },
    ),
    timeoutSeconds: Type.Optional(Type.Integer()),
  },
  { additionalProperties: false },
);

type AskUserGatewayCall = (
  method: string,
  opts: GatewayCallOptions,
  params?: unknown,
  extra?: { signal?: AbortSignal },
) => Promise<unknown>;

type AskUserCancellationOutcome = "cancelled" | "terminal" | "failed";

type PendingAskUserQuestion = {
  questionId: string;
  questions: QuestionRequestQuestion[];
  registration: Promise<unknown>;
  gatewayCall: AskUserGatewayCall;
  claimable: boolean;
  claimed: boolean;
};

type AskUserPromptDelivery = {
  questionId: string;
  questions: QuestionRequestQuestion[];
  result: Promise<{ error?: unknown }>;
  settle: (result: { error?: unknown }) => void;
  ready: Promise<QuestionRequestQuestion[] | undefined>;
  settleReady: (questions: QuestionRequestQuestion[] | undefined) => void;
  delivered: boolean;
  claimed: boolean;
  bufferedText?: string;
};

const pendingQuestionsBySession = new Map<string, PendingAskUserQuestion>();
const promptDeliveriesByQuestionId = new Map<string, AskUserPromptDelivery>();
const promptQuestionIdBySession = new Map<string, string>();

export type NormalizedAskUserParams = {
  questions: QuestionRequestQuestion[];
  timeoutSeconds: number;
};

function readRequiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new ToolInputError(`${label} must be a non-empty string`);
  }
  return value.trim();
}

function normalizeOption(value: unknown, questionIndex: number, optionIndex: number) {
  const labelPrefix = `questions[${questionIndex}].options[${optionIndex}]`;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ToolInputError(`${labelPrefix} must be an object`);
  }
  const record = value as Record<string, unknown>;
  const label = readRequiredString(record.label, `${labelPrefix}.label`);
  if (record.description !== undefined && typeof record.description !== "string") {
    throw new ToolInputError(`${labelPrefix}.description must be a string`);
  }
  const description =
    typeof record.description === "string" ? record.description.trim() : undefined;
  return { label, ...(description ? { description } : {}) };
}

/** Validates and canonicalizes model-authored ask_user arguments. */
export function normalizeAskUserParams(value: unknown): NormalizedAskUserParams {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ToolInputError("ask_user arguments must be an object");
  }
  const params = value as Record<string, unknown>;
  if (
    !Array.isArray(params.questions) ||
    params.questions.length < 1 ||
    params.questions.length > 3
  ) {
    throw new ToolInputError("questions must contain 1 to 3 questions");
  }
  const ids = new Set<string>();
  const questions = params.questions.map(
    (questionValue, questionIndex): QuestionRequestQuestion => {
      const prefix = `questions[${questionIndex}]`;
      if (!questionValue || typeof questionValue !== "object" || Array.isArray(questionValue)) {
        throw new ToolInputError(`${prefix} must be an object`);
      }
      const question = questionValue as Record<string, unknown>;
      const id = readRequiredString(question.id, `${prefix}.id`);
      if (!QUESTION_ID_PATTERN.test(id)) {
        throw new ToolInputError(`${prefix}.id must be snake_case (for example, deploy_target)`);
      }
      if (ids.has(id)) {
        throw new ToolInputError(`duplicate question id '${id}'`);
      }
      ids.add(id);
      const header = truncateUtf16Safe(readRequiredString(question.header, `${prefix}.header`), 12);
      const questionText = readRequiredString(question.question, `${prefix}.question`);
      if (
        !Array.isArray(question.options) ||
        question.options.length < 2 ||
        question.options.length > 4
      ) {
        throw new ToolInputError(`${prefix}.options must contain 2 to 4 options`);
      }
      if (question.multiSelect !== undefined && typeof question.multiSelect !== "boolean") {
        throw new ToolInputError(`${prefix}.multiSelect must be a boolean`);
      }
      return {
        id,
        header,
        question: questionText,
        options: question.options.map((option, optionIndex) =>
          normalizeOption(option, questionIndex, optionIndex),
        ),
        ...(question.multiSelect === true ? { multiSelect: true } : {}),
        isOther: true,
      };
    },
  );

  const rawTimeoutSeconds = params.timeoutSeconds;
  if (
    rawTimeoutSeconds !== undefined &&
    (typeof rawTimeoutSeconds !== "number" ||
      !Number.isFinite(rawTimeoutSeconds) ||
      !Number.isInteger(rawTimeoutSeconds))
  ) {
    throw new ToolInputError("timeoutSeconds must be an integer");
  }
  const timeoutSeconds = Math.min(
    MAX_ASK_USER_TIMEOUT_SECONDS,
    Math.max(MIN_ASK_USER_TIMEOUT_SECONDS, rawTimeoutSeconds ?? DEFAULT_ASK_USER_TIMEOUT_SECONDS),
  );
  return { questions, timeoutSeconds };
}

/** Stable client-generated gateway question id shared with tool-start delivery. */
export function buildAskUserQuestionId(toolCallId: string, sessionKey?: string): string {
  const identity = `${sessionKey?.trim() ?? ""}\0${toolCallId}`;
  return `ask_${createHash("sha256").update(identity).digest("hex").slice(0, 32)}`;
}

function promptSessionKey(sessionKey: string | undefined): string {
  return sessionKey?.trim() || "session:unknown";
}

/** Reserves one visible ask_user prompt slot before subscriber delivery. */
export function reserveAskUserPromptDelivery(params: {
  toolCallId: string;
  sessionKey?: string;
  questions: QuestionRequestQuestion[];
}): { questionId: string } | undefined {
  const sessionKey = promptSessionKey(params.sessionKey);
  if (promptQuestionIdBySession.has(sessionKey)) {
    return undefined;
  }
  const questionId = buildAskUserQuestionId(params.toolCallId, params.sessionKey);
  let settle!: AskUserPromptDelivery["settle"];
  let settleReady!: AskUserPromptDelivery["settleReady"];
  const result = new Promise<{ error?: unknown }>((resolve) => {
    settle = resolve;
  });
  const ready = new Promise<QuestionRequestQuestion[] | undefined>((resolve) => {
    settleReady = resolve;
  });
  promptDeliveriesByQuestionId.set(questionId, {
    questionId,
    questions: params.questions,
    result,
    settle,
    ready,
    settleReady,
    delivered: false,
    claimed: false,
  });
  promptQuestionIdBySession.set(sessionKey, questionId);
  return { questionId };
}

/** Waits until policy-accepted tool execution has registered the gateway question. */
export async function waitForAskUserPromptReady(
  questionId: string,
): Promise<QuestionRequestQuestion[] | undefined> {
  const delivery = promptDeliveriesByQuestionId.get(questionId);
  return delivery ? await delivery.ready : undefined;
}

/** Opens prompt delivery after question.request succeeds. */
export function markAskUserPromptReady(
  questionId: string,
  questions: QuestionRequestQuestion[],
): void {
  const delivery = promptDeliveriesByQuestionId.get(questionId);
  if (!delivery) {
    return;
  }
  delivery.questions = questions;
  delivery.settleReady(questions);
}

/** Records whether the originating-conversation prompt reached its delivery callback. */
export function settleAskUserPromptDelivery(questionId: string, error?: unknown): void {
  const delivery = promptDeliveriesByQuestionId.get(questionId);
  if (!delivery) {
    return;
  }
  delivery.delivered = error === undefined;
  delivery.settle(error === undefined ? {} : { error });
}

/** Returns whether a question-associated prompt still belongs to a blocking ask_user call. */
export function isAskUserPromptActive(questionId: string): boolean {
  return promptDeliveriesByQuestionId.has(questionId);
}

function releaseAskUserPromptDelivery(questionId: string, sessionKey: string | undefined): void {
  const delivery = promptDeliveriesByQuestionId.get(questionId);
  delivery?.settleReady(undefined);
  delivery?.settle({ error: new Error("ask_user prompt is no longer active") });
  promptDeliveriesByQuestionId.delete(questionId);
  const key = promptSessionKey(sessionKey);
  if (promptQuestionIdBySession.get(key) === questionId) {
    promptQuestionIdBySession.delete(key);
  }
}

/** Releases a tool-start reservation when policy rejects execution. */
export function cancelAskUserPromptDelivery(toolCallId: string, sessionKey?: string): void {
  releaseAskUserPromptDelivery(buildAskUserQuestionId(toolCallId, sessionKey), sessionKey);
}

function pendingSessionKey(sessionKey: string | undefined, agentId: string | undefined): string {
  return sessionKey?.trim() || `agent:${agentId?.trim() || "unknown"}`;
}

function answeredResult(questions: readonly QuestionRequestQuestion[], answers: QuestionAnswers) {
  const payload = { status: "answered" as const, answers };
  const lines = questions.map((question) => {
    const values = answers.answers[question.id]?.answers ?? [];
    return `${question.header}: ${values.length > 0 ? values.join(", ") : "(no answer)"}`;
  });
  return textResult(`${lines.join("\n")}\n\n${JSON.stringify(payload, null, 2)}`, payload);
}

function noAnswerResult(status: Exclude<QuestionWaitAnswerResult["status"], "answered">) {
  const payload = { status: "no_answer" as const };
  const note =
    status === "cancelled"
      ? "The question was cancelled; proceed with best judgment."
      : "No answer arrived; proceed with best judgment.";
  return textResult(`${note}\n\n${JSON.stringify(payload, null, 2)}`, payload);
}

async function waitForPromptDelivery(
  result: Promise<{ error?: unknown }>,
  signal?: AbortSignal,
): Promise<{ error?: unknown }> {
  if (!signal) {
    return await result;
  }
  signal.throwIfAborted();
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () =>
      reject(signal.reason instanceof Error ? signal.reason : new Error("ask_user aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([result, aborted]);
  } finally {
    if (onAbort) {
      signal.removeEventListener("abort", onAbort);
    }
  }
}

function readQuestionErrorReason(error: unknown): string | undefined {
  if (!error || typeof error !== "object") {
    return undefined;
  }
  const requestError = error as { details?: unknown; name?: unknown };
  if (requestError.name !== "GatewayClientRequestError") {
    return undefined;
  }
  const details = requestError.details;
  if (!details || typeof details !== "object" || Array.isArray(details)) {
    return undefined;
  }
  const reason = (details as { reason?: unknown }).reason;
  return typeof reason === "string" ? reason : undefined;
}

function isTerminalQuestionResolveError(error: unknown): boolean {
  const reason = readQuestionErrorReason(error);
  return reason !== undefined && TERMINAL_QUESTION_ERROR_REASONS.has(reason);
}

async function didGatewayCommitClaimedAnswer(
  pending: PendingAskUserQuestion,
  expectedAnswers: QuestionAnswers,
): Promise<boolean> {
  try {
    const result = (await pending.gatewayCall(
      "question.waitAnswer",
      { timeoutMs: ASK_USER_RPC_GRACE_MS },
      { id: pending.questionId, timeoutMs: 1_000 },
    )) as QuestionWaitAnswerResult;
    return (
      result.status === "answered" &&
      JSON.stringify(result.answers) === JSON.stringify(expectedAnswers)
    );
  } catch {
    return false;
  }
}

/** Claims the next queued plain-text message for this session's active question. */
export async function claimPendingAskUserAnswer(params: {
  sessionKey?: string;
  text: string;
  persist?: () => Promise<void>;
}): Promise<boolean> {
  const sessionKey = params.sessionKey?.trim();
  if (!sessionKey) {
    return false;
  }
  const pending = pendingQuestionsBySession.get(sessionKey);
  const promptQuestionId = promptQuestionIdBySession.get(promptSessionKey(sessionKey));
  const promptDelivery = promptQuestionId
    ? promptDeliveriesByQuestionId.get(promptQuestionId)
    : undefined;
  if (!pending) {
    if (!promptDelivery?.delivered || promptDelivery.claimed) {
      return false;
    }
    promptDelivery.claimed = true;
    try {
      await params.persist?.();
      promptDelivery.bufferedText = params.text;
      return true;
    } catch (error) {
      promptDelivery.claimed = false;
      throw error;
    }
  }
  if ((!pending.claimable && !promptDelivery?.delivered) || pending.claimed) {
    return false;
  }
  pending.claimed = true;
  if (promptDelivery) {
    promptDelivery.claimed = true;
  }
  const resetClaim = () => {
    pending.claimed = false;
    if (promptDelivery) {
      promptDelivery.claimed = false;
    }
  };
  try {
    await params.persist?.();
    await pending.registration;
  } catch (error) {
    resetClaim();
    throw error;
  }
  const answers = buildAgentHarnessUserInputAnswers(
    pending.questions as AgentHarnessUserInputQuestion[],
    params.text,
  );
  try {
    await pending.gatewayCall(
      "question.resolve",
      {},
      { id: pending.questionId, answers, resolvedBy: "plain-text" },
    );
    return true;
  } catch (error) {
    if (isTerminalQuestionResolveError(error)) {
      return false;
    }
    if (await didGatewayCommitClaimedAnswer(pending, answers)) {
      return true;
    }
    resetClaim();
    throw error;
  }
}

/** Cancels the blocking question before an inbound turn takes another route. */
export async function cancelPendingAskUserForSession(params: {
  sessionKey?: string;
  resolvedBy: string;
}): Promise<boolean> {
  const sessionKey = params.sessionKey?.trim();
  if (!sessionKey) {
    return false;
  }
  const pending = pendingQuestionsBySession.get(sessionKey);
  if (!pending) {
    return false;
  }
  pending.claimed = true;
  try {
    await pending.registration;
    await pending.gatewayCall(
      "question.resolve",
      { timeoutMs: ASK_USER_RPC_GRACE_MS },
      { id: pending.questionId, cancel: true, resolvedBy: params.resolvedBy },
    );
    return true;
  } catch (error) {
    if (isTerminalQuestionResolveError(error)) {
      return true;
    }
    pending.claimed = false;
    throw error;
  }
}

/** Test-only reset for process-local pending question state. */
export function resetPendingAskUserQuestionsForTest(): void {
  pendingQuestionsBySession.clear();
  promptDeliveriesByQuestionId.clear();
  promptQuestionIdBySession.clear();
}

/** Creates the main-session-only blocking ask_user tool. */
export function createAskUserTool(params: {
  agentId?: string;
  sessionKey?: string;
  gatewayCall?: AskUserGatewayCall;
}): AnyAgentTool {
  const gatewayCall: AskUserGatewayCall = params.gatewayCall ?? callGatewayTool;
  return {
    label: "Ask User",
    name: "ask_user",
    displaySummary: ASK_USER_TOOL_DISPLAY_SUMMARY,
    description: describeAskUserTool(),
    parameters: AskUserToolSchema,
    execute: async (toolCallId, args, signal) => {
      const questionId = buildAskUserQuestionId(toolCallId, params.sessionKey);
      let normalized: NormalizedAskUserParams;
      try {
        signal?.throwIfAborted();
        normalized = normalizeAskUserParams(args);
      } catch (error) {
        releaseAskUserPromptDelivery(questionId, params.sessionKey);
        throw error;
      }
      const sessionKey = pendingSessionKey(params.sessionKey, params.agentId);
      const reservedQuestionId = promptQuestionIdBySession.get(promptSessionKey(params.sessionKey));
      if (
        pendingQuestionsBySession.has(sessionKey) ||
        (reservedQuestionId !== undefined && reservedQuestionId !== questionId)
      ) {
        throw new ToolInputError(
          "ask_user already has a pending question for this session; wait for it to resolve before asking another",
        );
      }

      const timeoutMs = normalized.timeoutSeconds * 1_000;
      const registration = Promise.resolve().then(() =>
        gatewayCall(
          "question.request",
          {},
          {
            id: questionId,
            questions: normalized.questions,
            ...(params.agentId ? { agentId: params.agentId } : {}),
            ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
            timeoutMs,
          },
          signal ? { signal } : undefined,
        ),
      );
      const pending: PendingAskUserQuestion = {
        questionId,
        questions: normalized.questions,
        registration,
        gatewayCall,
        claimable: false,
        claimed: promptDeliveriesByQuestionId.get(questionId)?.claimed ?? false,
      };
      pendingQuestionsBySession.set(sessionKey, pending);

      let cancellation: Promise<AskUserCancellationOutcome> | undefined;
      let registered = false;
      const cancelPendingQuestion = (resolvedBy: string) => {
        cancellation ??= gatewayCall(
          "question.resolve",
          { timeoutMs: ASK_USER_RPC_GRACE_MS },
          { id: questionId, cancel: true, resolvedBy },
        ).then(
          () => "cancelled" as const,
          (error: unknown) => (isTerminalQuestionResolveError(error) ? "terminal" : "failed"),
        );
        return cancellation;
      };
      const recoverAnsweredAfterCancellation = async () => {
        if ((await cancellation) !== "terminal") {
          return undefined;
        }
        try {
          const result = (await gatewayCall(
            "question.waitAnswer",
            { timeoutMs: ASK_USER_RPC_GRACE_MS },
            { id: questionId, timeoutMs: 1_000 },
          )) as QuestionWaitAnswerResult;
          return result.status === "answered" ? result : undefined;
        } catch {
          return undefined;
        }
      };
      const cancelOnAbort = () => {
        releaseAskUserPromptDelivery(questionId, params.sessionKey);
        void cancelPendingQuestion("run-abort");
      };

      try {
        const requestResult = (await registration) as { id?: unknown };
        registered = true;
        if (requestResult.id !== questionId) {
          throw new Error("question.request returned an unexpected question id");
        }
        if (signal) {
          signal?.addEventListener("abort", cancelOnAbort, { once: true });
          if (signal.aborted) {
            cancelOnAbort();
            signal.throwIfAborted();
          }
        }
        markAskUserPromptReady(questionId, normalized.questions);
        const promptDelivery = promptDeliveriesByQuestionId.get(questionId);
        const promptDeliveryPromise = promptDelivery
          ? waitForPromptDelivery(promptDelivery.result, signal)
          : undefined;
        const answerPromise = gatewayCall(
          "question.waitAnswer",
          { timeoutMs: timeoutMs + ASK_USER_RPC_GRACE_MS },
          { id: questionId, timeoutMs },
          signal ? { signal } : undefined,
        ) as Promise<QuestionWaitAnswerResult>;
        if (promptDelivery && promptDeliveryPromise) {
          const first = await Promise.race([
            promptDeliveryPromise.then((result) => ({
              kind: "delivery" as const,
              result,
            })),
            answerPromise.then((result) => ({ kind: "answer" as const, result })),
          ]);
          signal?.throwIfAborted();
          if (first.kind === "answer") {
            if (first.result.status === "pending") {
              void cancelPendingQuestion("wait-timeout");
              const answered = await recoverAnsweredAfterCancellation();
              if (answered) {
                return answeredResult(normalized.questions, answered.answers);
              }
            }
            return first.result.status === "answered"
              ? answeredResult(normalized.questions, first.result.answers)
              : noAnswerResult(first.result.status);
          }
          const deliveryResult = first.result;
          if (deliveryResult.error !== undefined) {
            void cancelPendingQuestion("prompt-delivery-failed");
            const answered = await recoverAnsweredAfterCancellation();
            if (answered) {
              return answeredResult(normalized.questions, answered.answers);
            }
            throw new Error("ask_user prompt delivery failed", { cause: deliveryResult.error });
          }
          if (promptDelivery.bufferedText !== undefined) {
            const answers = buildAgentHarnessUserInputAnswers(
              promptDelivery.questions as AgentHarnessUserInputQuestion[],
              promptDelivery.bufferedText,
            );
            try {
              await gatewayCall(
                "question.resolve",
                {},
                { id: questionId, answers, resolvedBy: "plain-text" },
              );
            } catch (error) {
              if (!isTerminalQuestionResolveError(error)) {
                throw error;
              }
            }
          }
        }
        pending.claimable = true;
        const result = await answerPromise;
        signal?.throwIfAborted();
        if (result.status === "pending") {
          void cancelPendingQuestion("wait-timeout");
          const answered = await recoverAnsweredAfterCancellation();
          if (answered) {
            return answeredResult(normalized.questions, answered.answers);
          }
        }
        if (result.status === "answered") {
          return answeredResult(normalized.questions, result.answers);
        }
        if (
          result.status === "pending" ||
          result.status === "expired" ||
          result.status === "cancelled"
        ) {
          return noAnswerResult(result.status);
        }
        throw new Error("question.waitAnswer returned an invalid status");
      } catch (error) {
        if (registered || readQuestionErrorReason(error) !== "QUESTION_ID_IN_USE") {
          void cancelPendingQuestion(
            signal?.aborted ? "run-abort" : registered ? "tool-error" : "registration-failed",
          );
          await cancellation;
          if (!signal?.aborted) {
            const answered = await recoverAnsweredAfterCancellation();
            if (answered) {
              return answeredResult(normalized.questions, answered.answers);
            }
          }
        }
        throw error;
      } finally {
        signal?.removeEventListener("abort", cancelOnAbort);
        if (signal?.aborted) {
          cancelOnAbort();
          await cancellation;
        }
        if (pendingQuestionsBySession.get(sessionKey) === pending) {
          pendingQuestionsBySession.delete(sessionKey);
        }
        releaseAskUserPromptDelivery(questionId, params.sessionKey);
      }
    },
  };
}
