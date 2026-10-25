import {
  DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS,
  type GatewayProtocolRequestOptions,
} from "@openclaw/gateway-client/browser";
import type { QuestionAnswers, QuestionResolveResult } from "@openclaw/gateway-protocol";
import { afterEach, expect, vi } from "vitest";
import { GatewayRequestError } from "../api/gateway.ts";
import {
  createQuestionPromptState,
  disposeQuestionPromptState,
  handleQuestionPromptEvent,
  setQuestionPromptClient,
} from "./question-prompt.ts";

export type RequestFn = (
  method: string,
  params?: unknown,
  options?: GatewayProtocolRequestOptions,
) => Promise<unknown>;
export type QuestionState = ReturnType<typeof createQuestionPromptState>;
export type QuestionClient = { request: RequestFn };
export const detailedAnswer = { answers: { format: ["Detailed"] } };
export const compactAnswer = { answers: { format: ["Compact"] } };
export const defaultRequestDeadline = { timeoutMs: DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS };

export function requestedPayload(overrides: Record<string, unknown> = {}, displayMetadata = true) {
  return {
    id: "question-1",
    questions: [
      {
        questionId: "format",
        header: "Format",
        question: "Which format should I use?",
        options: [
          { label: "Compact", ...(displayMetadata ? { description: "Keep it brief" } : {}) },
          { label: "Detailed" },
        ],
        ...(displayMetadata ? { isOther: true } : {}),
      },
    ],
    agentId: "main",
    sessionKey: "agent:main:main",
    ...(displayMetadata ? { runId: "run-question" } : {}),
    createdAtMs: 1_000,
    expiresAtMs: Date.now() + 60_000,
    status: "pending",
    ...overrides,
  };
}

export function answeredPayload(overrides: Record<string, unknown> = {}) {
  return requestedPayload({ status: "answered", answers: detailedAnswer, ...overrides });
}

export function recordQuestionResolution(state: QuestionState, payload: unknown) {
  return handleQuestionPromptEvent(state, { event: "question.resolved", payload });
}

export function requestQuestion(
  state: QuestionState,
  overrides: Record<string, unknown> = {},
  displayMetadata = true,
) {
  return handleQuestionPromptEvent(state, {
    event: "question.requested",
    payload: requestedPayload(overrides, displayMetadata),
  });
}

export function resolvedQuestion(params?: unknown): QuestionResolveResult {
  const request = params as { answers?: QuestionAnswers; cancel?: true } | undefined;
  return request?.cancel
    ? { status: "cancelled" }
    : { status: "answered", answers: request?.answers ?? compactAnswer };
}

export function createQuestionResolver() {
  return vi.fn<RequestFn>(async (_method, params) => resolvedQuestion(params));
}

export function questionNotFoundError() {
  return new GatewayRequestError({
    code: "INVALID_REQUEST",
    message: "question was not found",
    details: { reason: "QUESTION_NOT_FOUND" },
  });
}

export function expectPrompt(state: QuestionState, expected: object, id = "question-1") {
  expect(state.prompts.get(id)).toMatchObject(expected);
}

export function createQuestionHarness() {
  const states: QuestionState[] = [];
  afterEach(() => {
    for (const state of states.splice(0)) {
      disposeQuestionPromptState(state);
    }
    vi.restoreAllMocks();
    vi.useRealTimers();
  });
  function createState(onChange: () => void = vi.fn()) {
    const state = createQuestionPromptState(onChange);
    states.push(state);
    return state;
  }
  function createConnectedState(
    request: RequestFn | QuestionClient,
    overrides: Record<string, unknown> | null = {},
  ) {
    const state = createState();
    const client = typeof request === "function" ? { request } : request;
    setQuestionPromptClient(state, client);
    if (overrides !== null) {
      requestQuestion(state, overrides);
    }
    return { state, client };
  }
  return { createState, createConnectedState };
}
