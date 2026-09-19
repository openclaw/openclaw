// Resolves runtime-authored question choices through the Gateway.
import type {
  QuestionGetResult,
  QuestionRecord,
  QuestionResolveResult,
} from "../../packages/gateway-protocol/src/schema/questions.js";
import { bindAgentToolGatewayRequest } from "../agents/tools/in-process-gateway.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { callGateway } from "../gateway/call.js";

const QUESTION_RECORD_ID_PATTERN = /^ask_[a-f0-9]{32}$/u;

export type ResolveQuestionOverGatewayResult =
  | { status: "answered"; questionId: string; optionValue: string }
  | { status: "custom-input"; questionId: string }
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
  gatewayUrl?: string;
  clientDisplayName?: string;
} & (
  | {
      /** Rendered option value carried by the pressed control (reactions). */
      optionValue: string;
      optionIndex?: never;
      customInput?: never;
    }
  | {
      /** Compact callback index; mapped to the canonical label via question.get. */
      optionIndex: number;
      optionValue?: never;
      customInput?: never;
    }
  | {
      /** Validate and retain the Gateway question for a typed custom answer. */
      customInput: true;
      optionIndex?: never;
      optionValue?: never;
    }
);

function readQuestionErrorReason(error: unknown): string | undefined {
  if (!(error instanceof Error) || error.name !== "GatewayClientRequestError") {
    return undefined;
  }
  const details = (error as Error & { details?: unknown }).details;
  if (!details || typeof details !== "object" || Array.isArray(details)) {
    return undefined;
  }
  const reason = (details as { reason?: unknown }).reason;
  return typeof reason === "string" ? reason : undefined;
}

function readTerminalReason(error: unknown): "already-terminal" | "not-found" | undefined {
  const reason = readQuestionErrorReason(error);
  if (reason === "QUESTION_ALREADY_TERMINAL") {
    return "already-terminal";
  }
  return reason === "QUESTION_NOT_FOUND" ? "not-found" : undefined;
}

type QuestionGatewayCallParams = {
  cfg: OpenClawConfig;
  questionId: string;
  senderId?: string | null;
  gatewayUrl?: string;
  clientDisplayName?: string;
};

function createQuestionGatewayCaller(params: QuestionGatewayCallParams) {
  if (!QUESTION_RECORD_ID_PATTERN.test(params.questionId)) {
    throw new Error("question resolution requires a valid question record id");
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
  return <T>(method: "question.get" | "question.resolve", methodParams: Record<string, unknown>) =>
    request<T>({ ...gatewayOptions, method, params: methodParams });
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
  const call = createQuestionGatewayCaller(params);
  if (
    params.customInput !== true &&
    params.optionValue === undefined &&
    !Number.isInteger(params.optionIndex)
  ) {
    throw new Error("question resolution requires an option value or index");
  }
  if (params.optionValue !== undefined && !params.optionValue) {
    throw new Error("question resolution requires a non-empty option value");
  }
  let getResult: QuestionGetResult;
  try {
    getResult = await call<QuestionGetResult>("question.get", { id: params.questionId });
  } catch (error) {
    const reason = readTerminalReason(error);
    if (reason) {
      return { status: "already-terminal", reason };
    }
    throw error;
  }

  const record = getResult.question;
  if (record.status !== "pending") {
    return { status: "already-terminal", reason: "already-terminal" };
  }
  const question = record.questions.length === 1 ? record.questions[0] : undefined;
  if (!question || question.multiSelect || question.isSecret) {
    throw new Error("question button resolution requires one tappable question");
  }
  if (params.customInput === true) {
    if (!question.isOther) {
      throw new Error("question does not allow a custom answer");
    }
    return { status: "custom-input", questionId: question.questionId };
  }
  const optionValue = params.optionValue ?? question.options[params.optionIndex as number]?.label;
  if (!optionValue) {
    throw new Error("question resolution index does not match a declared option");
  }
  if (params.authorize && !(await params.authorize())) {
    return { status: "denied" };
  }
  try {
    await call<QuestionResolveResult>("question.resolve", {
      id: params.questionId,
      answers: { answers: { [question.questionId]: [optionValue] } },
      resolvedBy: params.senderId?.trim() || undefined,
    });
  } catch (error) {
    const reason = readTerminalReason(error);
    if (reason) {
      return { status: "already-terminal", reason };
    }
    throw error;
  }
  return { status: "answered", questionId: question.questionId, optionValue };
}

async function readQuestionRecord(
  call: ReturnType<typeof createQuestionGatewayCaller>,
  questionId: string,
): Promise<QuestionRecord | null> {
  try {
    return (await call<QuestionGetResult>("question.get", { id: questionId })).question;
  } catch (error) {
    if (readTerminalReason(error) === "not-found") {
      return null;
    }
    throw error;
  }
}

/** Question record as channel plugins see it: submitted answers stay in the Gateway. */
export type ChannelQuestionRecord = Omit<QuestionRecord, "answers">;

/** Reads a question record; records the Gateway no longer holds return null. */
export async function getQuestionOverGateway(
  params: QuestionGatewayCallParams,
): Promise<ChannelQuestionRecord | null> {
  const record = await readQuestionRecord(createQuestionGatewayCaller(params), params.questionId);
  if (!record) {
    return null;
  }
  // Answers can hold secret values during the post-resolution grace window.
  const { answers: _answers, ...channelRecord } = record;
  return channelRecord;
}

export type ResolveQuestionAnswersOverGatewayResult =
  | { status: "answered" }
  | { status: "already-terminal"; reason: "already-terminal" | "not-found" }
  | { status: "invalid"; message: string }
  | { status: "denied" };

/**
 * Resolves every question in a record at once, for channels whose native form
 * collects the whole answer before submitting it. Secret questions stay on
 * their dedicated flow.
 */
export async function resolveQuestionAnswersOverGateway(
  params: QuestionGatewayCallParams & {
    answers: Record<string, string[]>;
    authorize: QuestionResolutionAuthorizer;
  },
): Promise<ResolveQuestionAnswersOverGatewayResult> {
  const call = createQuestionGatewayCaller(params);
  const record = await readQuestionRecord(call, params.questionId);
  if (!record) {
    return { status: "already-terminal", reason: "not-found" };
  }
  if (record.status !== "pending") {
    return { status: "already-terminal", reason: "already-terminal" };
  }
  if (record.questions.some((question) => question.isSecret || question.secretStore)) {
    throw new Error("question answer resolution does not accept secret questions");
  }
  if (!(await params.authorize())) {
    return { status: "denied" };
  }
  try {
    await call<QuestionResolveResult>("question.resolve", {
      id: params.questionId,
      answers: { answers: params.answers },
      resolvedBy: params.senderId?.trim() || undefined,
    });
  } catch (error) {
    const terminal = readTerminalReason(error);
    if (terminal) {
      return { status: "already-terminal", reason: terminal };
    }
    if (readQuestionErrorReason(error) === "QUESTION_INVALID_ANSWER") {
      return { status: "invalid", message: (error as Error).message };
    }
    throw error;
  }
  return { status: "answered" };
}

export type CancelQuestionOverGatewayResult =
  | { status: "cancelled" }
  | { status: "already-terminal"; reason: "already-terminal" | "not-found" }
  | { status: "denied" };

/** Cancels a pending question, such as when a person skips a native form. */
export async function cancelQuestionOverGateway(
  params: QuestionGatewayCallParams & { authorize: QuestionResolutionAuthorizer },
): Promise<CancelQuestionOverGatewayResult> {
  const call = createQuestionGatewayCaller(params);
  const record = await readQuestionRecord(call, params.questionId);
  if (!record) {
    return { status: "already-terminal", reason: "not-found" };
  }
  if (record.status !== "pending") {
    return { status: "already-terminal", reason: "already-terminal" };
  }
  if (!(await params.authorize())) {
    return { status: "denied" };
  }
  try {
    await call<QuestionResolveResult>("question.resolve", {
      id: params.questionId,
      cancel: true,
      resolvedBy: params.senderId?.trim() || undefined,
    });
  } catch (error) {
    const terminal = readTerminalReason(error);
    if (terminal) {
      return { status: "already-terminal", reason: terminal };
    }
    throw error;
  }
  return { status: "cancelled" };
}
