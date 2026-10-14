/* @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setChatHistoryRetrying } from "./chat-history-state.ts";
import { makeChatHost } from "./chat-host.test-support.ts";
import { resetChatViewState } from "./chat-view-state.ts";
import { renderChatView, renderChatInto, getComposerTextarea } from "./chat-view.test-helpers.ts";
import {
  installTranscriptDomMocks,
  resetTranscriptTestDom,
} from "./components/chat-transcript.test-support.ts";
beforeEach(installTranscriptDomMocks);
afterEach(() => {
  resetChatViewState();
  resetTranscriptTestDom();
});

describe("chat history recovery status", () => {
  it("keeps the cached transcript and draft visible during a quiet automatic retry", () => {
    const messages = [{ role: "assistant", content: "Cached conversation" }];
    const state = makeChatHost({ chatMessages: messages, chatMessage: "Unsent draft" });
    setChatHistoryRetrying(state, "subscription", true);
    const props = {
      historyState: state,
      sessionKey: state.sessionKey,
      messages,
      draft: state.chatMessage,
    };
    const container = renderChatView(props);
    expect(container.querySelector(".chat-history-error--inline")).toBeNull();
    expect(container.textContent).not.toContain("Restoring");
    expect(container.querySelector(".chat-thread")).not.toBeNull();
    expect(getComposerTextarea(container).value).toBe("Unsent draft");
    setChatHistoryRetrying(state, "subscription", false);
    renderChatInto(container, props);
    expect(container.querySelector(".chat-history-error--inline")).toBeNull();
  });
});
