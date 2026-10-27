/* @vitest-environment jsdom */

import { expect, it, vi } from "vitest";
import { createQuestionPromptState } from "../../app/question-prompt.ts";
import { createChatQuestionActions } from "./chat-question-actions.ts";
import {
  createAsyncQuestionPresentation,
  subscribeAsyncQuestionState,
} from "./components/chat-async-question.ts";

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
    };
    let current = true;
    const actions = createChatQuestionActions({
      state,
      questionState: createQuestionPromptState(() => {}),
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
