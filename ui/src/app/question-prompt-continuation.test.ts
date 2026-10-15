// @vitest-environment node
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  createQuestionPromptState,
  disposeQuestionPromptState,
  handleQuestionPromptEvent,
  setQuestionPromptClient,
  submitQuestionPrompt,
} from "./question-prompt.ts";

const states: ReturnType<typeof createQuestionPromptState>[] = [];
afterEach(() => {
  for (const state of states.splice(0)) {
    disposeQuestionPromptState(state);
  }
});

const question = {
  id: "receipt-question",
  agentId: "main",
  sessionKey: "agent:main:main",
  createdAtMs: 1_000,
  expiresAtMs: Date.now() + 60_000,
  status: "pending",
  questions: [
    {
      questionId: "environment",
      header: "Environment",
      question: "Where should the release go?",
      options: [{ label: "Staging" }, { label: "Production" }],
    },
  ],
};
const resolution = {
  event: "question.resolved",
  payload: {
    id: question.id,
    status: "answered",
    answers: { answers: { environment: ["Staging"] } },
  },
};
const receiptResponse = {
  questions: [question],
  continuations: [
    {
      questionId: question.id,
      status: "blocked",
      reason: "Original caller is unavailable.",
      nextAction: "Start a new user turn.",
    },
  ],
};

function heldReceipt() {
  let finish: (value: unknown) => void = () => {};
  const request = vi.fn(
    () =>
      new Promise<unknown>((resolve) => {
        finish = resolve;
      }),
  );
  const state = createQuestionPromptState(vi.fn());
  states.push(state);
  const client = { request };
  setQuestionPromptClient(state, client);
  handleQuestionPromptEvent(state, { event: "question.requested", payload: question });
  handleQuestionPromptEvent(state, resolution);
  return { state, request, client, finish: () => finish(receiptResponse) };
}

it("attaches a live receipt without replacing the accepted answer with a stale pending snapshot", async () => {
  const { state, request, finish } = heldReceipt();
  finish();
  await vi.waitFor(() =>
    expect(state.prompts.get(question.id)?.continuationMessage).toBe(
      "Original caller is unavailable. Start a new user turn.",
    ),
  );
  expect(state.prompts.get(question.id)).toMatchObject({
    status: "answered",
    answers: resolution.payload.answers,
    answeredElsewhere: true,
  });
  expect(request).toHaveBeenCalledTimes(1);
  expect(state.refreshRetryTimer).toBeNull();
});

it.each(["revision", "client", "prompt"] as const)(
  "discards a held receipt after its captured %s owner changes",
  async (changedOwner) => {
    const { state, finish } = heldReceipt();
    if (changedOwner === "revision") {
      const prompt = state.prompts.get(question.id);
      if (!prompt) {
        throw new Error("The answered prompt must exist before receipt invalidation");
      }
      prompt.revision += 1;
    } else if (changedOwner === "client") {
      setQuestionPromptClient(state, null);
    } else {
      state.prompts.clear();
      handleQuestionPromptEvent(state, { event: "question.requested", payload: question });
    }
    finish();
    await Promise.resolve();
    await Promise.resolve();
    expect(state.prompts.get(question.id)?.continuationMessage).toBeUndefined();
    expect(state.refreshRetryTimer).toBeNull();
  },
);

it("leaves unmatched outcomes to reconnect recovery without reading or scheduling", () => {
  const request = vi.fn(async () => receiptResponse);
  const state = createQuestionPromptState(vi.fn());
  states.push(state);
  setQuestionPromptClient(state, { request });
  handleQuestionPromptEvent(state, resolution);
  expect(state.unmatchedResolutions.has(question.id)).toBe(true);
  expect(request).not.toHaveBeenCalled();
  expect(state.refreshRetryTimer).toBeNull();
});

it("retains delayed receipts in sibling projections after the local RPC confirms an answer broadcast", async () => {
  const answer = createDeferred<unknown>();
  const receipt = createDeferred<unknown>();
  const request = vi.fn((method: string) =>
    method === "question.resolve" ? answer.promise : receipt.promise,
  );
  const state = createQuestionPromptState(vi.fn());
  const sibling = createQuestionPromptState(vi.fn());
  const client = { request };
  states.push(state, sibling);
  for (const owner of [state, sibling]) {
    setQuestionPromptClient(owner, client);
    handleQuestionPromptEvent(owner, { event: "question.requested", payload: question });
  }
  const submitted = submitQuestionPrompt(state, question.id, { environment: ["Staging"] });
  handleQuestionPromptEvent(state, resolution);
  handleQuestionPromptEvent(sibling, resolution);
  answer.resolve(resolution.payload);
  await submitted;
  receipt.resolve(receiptResponse);
  await vi.waitFor(() =>
    expect(state.prompts.get(question.id)?.continuationMessage).toBe(
      "Original caller is unavailable. Start a new user turn.",
    ),
  );
  await vi.waitFor(() =>
    expect(sibling.prompts.get(question.id)?.continuationMessage).toBe(
      "Original caller is unavailable. Start a new user turn.",
    ),
  );
  expect(state.prompts.get(question.id)).toMatchObject({
    status: "answered",
    answers: resolution.payload.answers,
    localResolutionConfirmed: true,
  });
});
