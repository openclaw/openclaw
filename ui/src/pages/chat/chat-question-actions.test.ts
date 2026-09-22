/* @vitest-environment jsdom */

import { expect, it, vi } from "vitest";
import { createQuestionPromptState } from "../../app/question-prompt.ts";
import { createChatQuestionActions } from "./chat-question-actions.ts";
import { createAsyncQuestionPresentation } from "./components/chat-async-question.ts";

it.each(["session", "connection", "pane"] as const)(
  "does not admit a retained question submission after its %s changes",
  async (changed) => {
    const send = vi.fn(async () => true);
    const state = {
      sessionKey: "agent:main:one",
      connectionEpoch: 1,
      handleSendChat: send,
      lastError: null,
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
    } else {
      current = false;
    }
    expect(await actions.onAsyncQuestionSubmit?.("> Which audience?\n\nEveryone")).toBe(false);
    expect(send).not.toHaveBeenCalled();
  },
);

it.each(["session", "connection", "agent", "drafts"] as const)(
  "does not route a retained question card through the latest callback after %s rollover",
  async (changed) => {
    const originalSend = vi.fn(async () => true);
    const nextSend = vi.fn(async () => true);
    const state: Parameters<typeof createAsyncQuestionPresentation>[0] = {
      asyncQuestionDrafts: new Map(),
      transcriptRenderContext: { onAsyncQuestionSubmit: originalSend },
    };
    const props = {
      sessionKey: "global",
      currentAgentId: "main",
      connectionEpoch: 1,
      onAsyncQuestionSubmit: originalSend,
    };
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
    expect(await retained.submit?.("> Which audience?\n\nEveryone")).toBe(false);
    expect(originalSend).not.toHaveBeenCalled();
    expect(nextSend).not.toHaveBeenCalled();
    expect(await current.submit?.("> Which audience?\n\nEngineers")).toBe(true);
    expect(nextSend).toHaveBeenCalledExactlyOnceWith("> Which audience?\n\nEngineers");
  },
);
