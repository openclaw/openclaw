/* @vitest-environment jsdom */

import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import {
  createQuestionHarness,
  createQuestionResolver,
  detailedAnswer,
  recordQuestionResolution,
  requestQuestion,
} from "../../app/question-prompt.test-support.ts";
import { setQuestionPromptClient } from "../../app/question-prompt.ts";
import { createChatQuestionActions } from "./chat-question-actions.ts";
import type { ChatProps } from "./chat-view.tsx";
import {
  createAsyncQuestionPresentation,
  subscribeAsyncQuestionState,
} from "./components/chat-async-question.ts";

const questions = createQuestionHarness();

function sendingQuestion(onSend: ChatProps["onSend"]) {
  const request = createQuestionResolver();
  const { state: questionState, client } = questions.createConnectedState(request);
  const state: Parameters<typeof createChatQuestionActions>[0]["state"] = {
    sessionKey: "agent:main:main",
    connectionEpoch: 1,
    handleSendChat: vi.fn(),
    lastError: null,
    chatQueue: [],
    chatMessage: "Use the supported workflow instead.",
  };
  let current = true;
  const actions = createChatQuestionActions({
    state,
    questionState,
    prompts: questionState.snapshot,
    sendActions: { onSend },
    canSend: true,
    isCurrent: () => current,
  });
  return { state, questionState, request, client, actions, retire: () => (current = false) };
}

it("cancels only the pending snapshot, not new or already answered questions", async () => {
  const send = createDeferred<boolean>();
  const { actions, questionState, request } = sendingQuestion(() => send.promise);
  const submitted = actions.onSend();
  expect(request).not.toHaveBeenCalled();
  requestQuestion(questionState, { id: "new-question" });
  send.resolve(true);
  await expect(submitted).resolves.toBe(true);
  expect(request.mock.calls.map(([method, params]) => [method, params])).toEqual([
    ["question.resolve", { id: "question-1", cancel: true }],
  ]);
  expect(questionState.prompts.get("question-1")?.status).toBe("cancelled");
  expect(questionState.prompts.get("new-question")?.status).toBe("pending");

  const laterSend = createDeferred<boolean>();
  const later = sendingQuestion(() => laterSend.promise);
  const laterSubmitted = later.actions.onSend();
  recordQuestionResolution(later.questionState, {
    id: "question-1",
    status: "answered",
    answers: detailedAnswer,
  });
  laterSend.resolve(true);
  await laterSubmitted;
  expect(later.request).not.toHaveBeenCalled();
  expect(later.questionState.prompts.get("question-1")?.status).toBe("answered");
});

it.each([false, undefined, "rejected"] as const)(
  "keeps the question when sending returns %s",
  async (result) => {
    const { actions, questionState, request } = sendingQuestion(async () => {
      if (result === "rejected") {
        throw new Error("send failed");
      }
      return result;
    });
    if (result === "rejected") {
      await expect(actions.onSend()).rejects.toThrow("send failed");
    } else {
      await expect(actions.onSend()).resolves.toBe(result);
    }
    expect(request).not.toHaveBeenCalled();
    expect(questionState.prompts.get("question-1")?.status).toBe("pending");
  },
);

it.each(["session", "connection", "pane", "question-client"] as const)(
  "does not cancel across a %s change while sending",
  async (changed) => {
    const send = createDeferred<boolean>();
    const fixture = sendingQuestion(() => send.promise);
    const submitted = fixture.actions.onSend();
    if (changed === "session") {
      fixture.state.sessionKey = "agent:main:other";
    } else if (changed === "connection") {
      fixture.state.connectionEpoch += 1;
    } else if (changed === "pane") {
      fixture.retire();
    } else {
      setQuestionPromptClient(fixture.questionState, null);
      setQuestionPromptClient(fixture.questionState, fixture.client);
    }
    send.resolve(true);
    await submitted;
    expect(fixture.request).not.toHaveBeenCalled();
    expect(fixture.questionState.prompts.get("question-1")?.status).toBe("pending");
  },
);

it("retains a failed cancellation without failing or replaying the accepted prompt", async () => {
  const send = vi.fn(async () => true);
  const { actions, questionState, request } = sendingQuestion(send);
  request.mockRejectedValue(new Error("question service unavailable"));
  await expect(actions.onSend()).resolves.toBe(true);
  expect(send).toHaveBeenCalledOnce();
  expect(questionState.prompts.get("question-1")).toMatchObject({
    status: "pending",
    submitting: false,
    error: "question service unavailable",
  });
});

it("settles a question once when another prompt sends during cancellation", async () => {
  const { actions, questionState, request } = sendingQuestion(async () => true);
  const cancelling = createDeferred();
  const result = createDeferred<{ status: "cancelled" }>();
  request.mockImplementationOnce(async () => {
    cancelling.resolve();
    return result.promise;
  });
  const first = actions.onSend();
  await cancelling.promise;
  const second = actions.onSend();
  result.resolve({ status: "cancelled" });
  await Promise.all([first, second]);
  expect(request).toHaveBeenCalledOnce();
  expect(questionState.prompts.get("question-1")?.status).toBe("cancelled");
});

it("does not supersede a question for an explicitly queued message", async () => {
  const send = vi.fn(async () => true);
  const { actions, questionState, request } = sendingQuestion(send);
  await expect(actions.onSend("queue")).resolves.toBe(true);
  expect(send).toHaveBeenCalledWith("queue");
  expect(request).not.toHaveBeenCalled();
  expect(questionState.prompts.get("question-1")?.status).toBe("pending");
});

it("does not supersede a question for a slash command", async () => {
  const { actions, state, questionState, request } = sendingQuestion(async () => true);
  state.chatMessage = "/model openai/example";
  await actions.onSend();
  expect(request).not.toHaveBeenCalled();
  expect(questionState.prompts.get("question-1")?.status).toBe("pending");
});

it.each(["session", "connection", "pane", "outbox"] as const)(
  "does not resubmit a question after %s changes",
  async (changed) => {
    const send = vi.fn(async () => true);
    const pendingAnswer = {
      id: "pending-answer",
      asyncQuestionItemId: "audience",
      text: "Original answer",
      createdAt: 1,
      sendState: "failed" as const,
    };
    const state: Parameters<typeof createChatQuestionActions>[0]["state"] = {
      sessionKey: "agent:main:one",
      connectionEpoch: 1,
      handleSendChat: send,
      lastError: null,
      chatQueue: changed === "outbox" ? [pendingAnswer] : [],
      chatMessage: "",
    };
    let current = true;
    const actions = createChatQuestionActions({
      state,
      questionState: questions.createState(),
      prompts: [],
      sendActions: { onSend: vi.fn() },
      canSend: true,
      isCurrent: () => current,
    });
    if (changed === "session") {
      state.sessionKey = "agent:main:two";
    } else if (changed === "connection") {
      state.connectionEpoch += 1;
    } else if (changed === "pane") {
      current = false;
    }
    const itemId = changed === "outbox" ? "audience" : undefined;
    expect(await actions.onAsyncQuestionSubmit?.("Changed draft", itemId)).toBe(
      changed === "outbox",
    );
    expect(send).not.toHaveBeenCalled();
  },
);

it.each(["session", "connection", "agent", "drafts"] as const)(
  "does not route a retained question card through the latest callback after %s rollover",
  async (changed) => {
    const originalSend = vi.fn(async () => true);
    const nextSend = vi.fn(async () => true);
    const notify = vi.fn();
    const state: Parameters<typeof createAsyncQuestionPresentation>[0] = {
      asyncQuestionDrafts: new Map(),
      asyncQuestionRevision: 0,
      transcriptRenderContext: { onAsyncQuestionSubmit: originalSend },
    };
    const props = {
      sessionKey: "global",
      currentAgentId: "main",
      connectionEpoch: 1,
      onAsyncQuestionSubmit: originalSend,
    };
    const stop = subscribeAsyncQuestionState(state, notify);
    const retained = createAsyncQuestionPresentation(state, props);
    if (changed === "session") {
      props.sessionKey = "agent:main:two";
    } else if (changed === "connection") {
      props.connectionEpoch += 1;
    } else if (changed === "agent") {
      props.currentAgentId = "other";
    } else {
      state.asyncQuestionDrafts = new Map();
    }
    state.transcriptRenderContext.onAsyncQuestionSubmit = nextSend;
    const current = createAsyncQuestionPresentation(state, props);
    retained.onChange();
    expect(notify).not.toHaveBeenCalled();
    current.onChange();
    expect(notify).toHaveBeenCalledOnce();
    stop();
    expect(await retained.submit?.("> Which audience?\n\nEveryone")).toBe(false);
    expect([originalSend.mock.calls, nextSend.mock.calls]).toEqual([[], []]);
    const answer = "> Which audience?\n\nEngineers";
    expect(await current.submit?.(answer)).toBe(true);
    expect(nextSend.mock.calls).toEqual([[answer, undefined, undefined]]);
  },
);
