/* @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setChatHistoryRetrying } from "./chat-history-state.ts";
import { makeChatHost } from "./chat-host.test-support.ts";
import { admitChatHistoryPages } from "./chat-pane-history-packets.runtime.ts";
import { resetChatViewState } from "./chat-view-state.test-support.ts";
import {
  renderChatView,
  renderChatInto,
  getComposerTextarea,
  requireElement,
} from "./chat-view.test-helpers.ts";
import { createChatTranscript } from "./components/chat-transcript-controller.ts";
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
  it("replaces the committed transcript with an admitted single-source around packet", async () => {
    const row = (id: string, seq: number, role: string) => ({
      role,
      content: id === "target" ? "Short reader target" : `${id} answer`,
      __openclaw: { id, seq },
    });
    const messages = [
      row("previous", 1, "assistant"),
      row("target", 2, "user"),
      row("newer", 3, "assistant"),
    ];
    const state = makeChatHost({ chatMessages: messages });
    const transcript = createChatTranscript(() => "around-replacement");
    const props = { transcript, sessionKey: state.sessionKey, messages: state.chatMessages };
    const container = renderChatView(props);
    await vi.waitFor(() => expect(container.textContent).toContain("previous answer"));
    const target = row("target", 2, "user");
    admitChatHistoryPages(
      state,
      [{ messages: [target], olderCursor: "before-target", newerCursor: "after-target" }],
      "around",
    );
    expect(state.chatMessages).toEqual([target]);
    renderChatInto(container, { ...props, messages: state.chatMessages });
    await vi.waitFor(() =>
      expect(
        [...container.querySelectorAll<HTMLElement>(".chat-bubble[data-message-id]")].map(
          (bubble) => bubble.dataset.messageId,
        ),
      ).toEqual(["msg:id:target:0"]),
    );
    expect(container.textContent).not.toContain("previous answer");
    expect(container.textContent).not.toContain("newer answer");
    transcript.dispose();
  });

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

describe("chat history pagination", () => {
  it("loads older history from upward wheel and keyboard intent across transcript updates", () => {
    const onHistoryIntent = vi.fn();
    const transcript = createChatTranscript(() => "history-intent-transcript", { onHistoryIntent });
    const props = {
      transcript,
      messages: [{ role: "assistant", content: "Current history" }],
      historyPagination: {
        hasMore: true,
        loading: false,
        onShowEarlier: vi.fn(),
      },
      onHistoryIntent,
    };
    const container = renderChatView(props);
    const thread = requireElement(container, ".chat-thread", "chat thread");
    const sentinel = requireElement(container, ".chat-history-sentinel", "history sentinel");

    expect(sentinel.querySelector("button")).toBeNull();
    thread.dispatchEvent(new WheelEvent("wheel", { deltaY: -1, bubbles: true }));
    thread.dispatchEvent(new KeyboardEvent("keydown", { key: "PageUp", bubbles: true }));
    expect(onHistoryIntent).toHaveBeenCalledTimes(2);

    renderChatInto(container, {
      ...props,
      messages: [...props.messages, { role: "assistant", content: "Updated history" }],
    });
    expect(container.querySelector(".chat-history-sentinel")).toBe(sentinel);
    expect(thread.contains(sentinel)).toBe(true);
    thread.dispatchEvent(new WheelEvent("wheel", { deltaY: -1, bubbles: true }));
    expect(onHistoryIntent).toHaveBeenCalledTimes(3);

    renderChatInto(container, { messages: props.messages, onHistoryIntent });
    expect(container.querySelector(".chat-history-sentinel")).toBeNull();
    expect(thread.contains(sentinel)).toBe(false);
  });
});
