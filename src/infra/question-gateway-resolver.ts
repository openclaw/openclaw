// Resolves runtime-authored question choices through the Gateway.
import type {
  QuestionGetResult,
  QuestionResolveResult,
} from "../../packages/gateway-protocol/src/schema/questions.js";
import { bindAgentToolGatewayRequest } from "../agents/tools/in-process-gateway.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { callGateway } from "../gateway/call.js";

const QUESTION_RECORD_ID_PATTERN = /^ask_[a-f0-9]{32}$/u;

export type ResolveQuestionOverGatewayResult =
  | { status: "answered"; questionId: string; optionValue: string }
  | { status: "custom-input"; questionId: string }
  | {
      status: "pending";
      questionId: string;
      optionValue?: string;
      selectedValues: string[];
      completed: boolean;
    }
  | { status: "already-terminal"; reason: "already-terminal" | "not-found" };

/**
 * Re-checked after the awaited question read and immediately before the resolve
 * write, so access lost during that window cannot answer.
 */
export type QuestionResolutionAuthorizer = () => boolean | Promise<boolean>;

/** Only a caller that supplies an authorizer can receive this. */
export type ResolveQuestionOverGatewayDenial = { status: "denied" };

export type ResolveQuestionOverGatewayParams = {
  cfg: OpenClawConfig;
  questionId: string;
  senderId?: string | null;
  expectedSessionKey?: string;
  gatewayUrl?: string;
  clientDisplayName?: string;
  questionIndex?: number;
  selected?: boolean;
  conflictRetry?: boolean;
} & (
  | {
      /** Rendered option value carried by the pressed control (reactions). */
      optionValue: string;
      optionIndex?: never;
      customInput?: never;
      done?: never;
    }
  | {
      /** Compact callback index; mapped to the canonical label via question.get. */
      optionIndex: number;
      optionValue?: never;
      customInput?: never;
      done?: never;
    }
  | {
      done: true;
      optionIndex?: never;
      optionValue?: never;
      customInput?: never;
    }
  | {
      /** Validate and retain the Gateway question for a typed custom answer. */
      customInput: true;
      optionIndex?: never;
      optionValue?: never;
      done?: never;
    }
);

function terminalResolution(
  error: unknown,
): Extract<ResolveQuestionOverGatewayResult, { status: "already-terminal" }> {
  if (!(error instanceof Error) || error.name !== "GatewayClientRequestError") {
    throw error;
  }
  const details = (error as Error & { details?: unknown }).details;
  if (!details || typeof details !== "object" || Array.isArray(details)) {
    throw error;
  }
  const reason = (details as { reason?: unknown }).reason;
  if (reason === "QUESTION_ALREADY_TERMINAL") {
    return { status: "already-terminal", reason: "already-terminal" };
  }
  if (reason === "QUESTION_NOT_FOUND") {
    return { status: "already-terminal", reason: "not-found" };
  }
  throw error;
}

/** Params for the overload that re-checks access before the resolve write. */
export type AuthorizedResolveQuestionOverGatewayParams = ResolveQuestionOverGatewayParams & {
  authorize: QuestionResolutionAuthorizer;
};

/** Resolves one rendered choice or validates a custom-input transition. */
// Only the authorized overload widens the result, so callers that never opt in
// keep the result union they already exhaust.
export async function resolveQuestionOverGateway(
  params: AuthorizedResolveQuestionOverGatewayParams,
): Promise<ResolveQuestionOverGatewayResult | ResolveQuestionOverGatewayDenial>;
export async function resolveQuestionOverGateway(
  params: ResolveQuestionOverGatewayParams,
): Promise<ResolveQuestionOverGatewayResult>;
export async function resolveQuestionOverGateway(
  params: ResolveQuestionOverGatewayParams & { authorize?: QuestionResolutionAuthorizer },
): Promise<ResolveQuestionOverGatewayResult | ResolveQuestionOverGatewayDenial> {
  if (!QUESTION_RECORD_ID_PATTERN.test(params.questionId)) {
    throw new Error("question resolution requires a valid question record id");
  }
  if (
    params.customInput !== true &&
    params.done !== true &&
    params.optionValue === undefined &&
    !Number.isInteger(params.optionIndex)
  ) {
    throw new Error("question resolution requires an option value or index");
  }
  if (params.optionValue !== undefined && !params.optionValue) {
    throw new Error("question resolution requires a non-empty option value");
  }
  const gatewayOptions = {
    config: params.cfg,
    url: params.gatewayUrl,
    scopes: ["operator.questions" as const],
    clientDisplayName:
      params.clientDisplayName ?? `Question (${params.senderId?.trim() || "unknown"})`,
  };
  const request = params.gatewayUrl?.trim()
    ? callGateway
    : bindAgentToolGatewayRequest({ hostedOnly: true });
  let getResult: QuestionGetResult;
  try {
    getResult = await request<QuestionGetResult>({
      ...gatewayOptions,
      method: "question.get",
      params: { id: params.questionId },
    });
  } catch (error) {
    return terminalResolution(error);
  }

  const record = getResult.question;
  if (params.expectedSessionKey && record.sessionKey !== params.expectedSessionKey) {
    return { status: "denied" };
  }
  if (record.status !== "pending") {
    return { status: "already-terminal", reason: "already-terminal" };
  }
  const question = record.questions[params.questionIndex ?? 0];
  if (
    !question ||
    question.isSecret ||
    (params.questionIndex === undefined && record.questions.length !== 1)
  ) {
    throw new Error(
      "question button resolution requires one tappable question or an explicit question index",
    );
  }
  if (params.customInput === true) {
    if (record.draftCompletedIds?.includes(question.questionId)) {
      return { status: "already-terminal", reason: "already-terminal" };
    }
    if (params.authorize && !(await params.authorize())) {
      return { status: "denied" };
    }
    if (!question.isOther) {
      throw new Error("question does not allow a custom answer");
    }
    return { status: "custom-input", questionId: question.questionId };
  }
  if (params.questionIndex !== undefined || question.multiSelect) {
    if (record.draftCompletedIds?.includes(question.questionId)) {
      return { status: "already-terminal", reason: "already-terminal" };
    }
    if (params.done === true && !question.multiSelect) {
      throw new Error("Done is only valid for multi-select questions");
    }
    const selected = record.draftAnswers?.answers[question.questionId] ?? [];
    const option =
      params.optionIndex === undefined ? undefined : question.options[params.optionIndex];
    const value = params.optionValue ?? option?.value ?? option?.label;
    if (params.done !== true && !value) {
      throw new Error("question resolution index does not match a declared option");
    }
    if (params.authorize && !(await params.authorize())) {
      return { status: "denied" };
    }
    const next =
      params.done === true
        ? selected
        : question.multiSelect
          ? params.selected === false
            ? selected.filter((item) => item !== value)
            : [...new Set([...selected, value!])]
          : [value!];
    let result: QuestionResolveResult;
    try {
      result = await request<QuestionResolveResult>({
        ...gatewayOptions,
        method: "question.resolve",
        params: {
          id: params.questionId,
          draftAnswers: { answers: { [question.questionId]: next } },
          expectedRevision: record.draftRevision ?? 0,
          ...(!question.multiSelect || params.done === true
            ? { completeQuestionId: question.questionId }
            : {}),
        },
      });
    } catch (error) {
      if (error instanceof Error && error.name === "GatewayClientRequestError") {
        const reason = (error as Error & { details?: { reason?: string } }).details?.reason;
        if (reason === "QUESTION_DRAFT_CONFLICT" && !params.conflictRetry) {
          return resolveQuestionOverGateway({ ...params, conflictRetry: true });
        }
      }
      return terminalResolution(error);
    }
    if (result.status === "cancelled") {
      return { status: "already-terminal", reason: "already-terminal" };
    }
    return result.status === "answered"
      ? {
          status: "answered",
          questionId: question.questionId,
          optionValue: value ?? selected.join(", "),
        }
      : {
          status: "pending",
          questionId: question.questionId,
          optionValue: value,
          selectedValues: next,
          completed: result.question.draftCompletedIds?.includes(question.questionId) ?? false,
        };
  }
  const option = question.options[params.optionIndex as number];
  const optionValue = params.optionValue ?? option?.value ?? option?.label;
  if (!optionValue) {
    throw new Error("question resolution index does not match a declared option");
  }
  if (params.authorize && !(await params.authorize())) {
    return { status: "denied" };
  }
  try {
    await request<QuestionResolveResult>({
      ...gatewayOptions,
      method: "question.resolve",
      params: {
        id: params.questionId,
        answers: { answers: { [question.questionId]: [optionValue] } },
        resolvedBy: params.senderId?.trim() || undefined,
      },
    });
  } catch (error) {
    return terminalResolution(error);
  }
  return { status: "answered", questionId: question.questionId, optionValue };
}
