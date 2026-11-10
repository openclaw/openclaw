/* @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createComposerContainer } from "./chat-composer.test-support.ts";
import { TranscriptHistoryInput } from "./chat-scroll-input.ts";
import { resetChatViewState } from "./chat-view-state.test-support.ts";
import {
  renderChatInto,
  renderChatView,
  requireElement,
  waitForElement,
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

describe("chat history pagination", () => {
  it("keeps earlier history discoverable and retryable until the transcript is exhausted", async () => {
    const onShowEarlier = vi.fn();
    const container = createComposerContainer();
    for (const [loading, connected, clicks] of [
      [false, false, 0],
      [true, true, 0],
      [false, true, 1],
    ] as const) {
      renderChatInto(container, {
        historyPagination: { hasMore: true, loading, connected, onShowEarlier },
      });
      const button = (await waitForElement(
        container,
        ".chat-history-boundary__action",
      )) as HTMLButtonElement;
      expect(button.querySelector('[role="status"]')?.textContent?.trim()).toBe("Show earlier");
      expect(button.getAttribute("aria-label")).toBe("Show earlier");
      expect(button.getAttribute("aria-busy")).toBe(String(loading));
      expect(button.disabled).toBe(false);
      expect(button.closest(".chat-thread")).not.toBeNull();
      if (loading) {
        expect(button.getAttribute("aria-disabled")).toBe("true");
        expect(button.closest(".chat-history-boundary--loading")).not.toBeNull();
      }
      button.click();
      expect(onShowEarlier).toHaveBeenCalledTimes(clicks);
    }

    renderChatInto(container);
    expect(container.querySelector(".chat-history-boundary")).toBeNull();
    expect(container.querySelector(".chat-history-sentinel")).toBeNull();
  });

  it("loads older history from upward wheel and keyboard intent across transcript updates", async () => {
    const historyInput = new TranscriptHistoryInput();
    const onBoundaryRead = vi.fn();
    const onHistoryIntent = (event: Event) => {
      const direction = historyInput.readBoundaryDirection(event, 0);
      if (direction) {
        onBoundaryRead(direction);
      }
    };
    const onRequestEnd = vi.fn();
    const transcript = createChatTranscript(() => "pagination-input", {
      onHistoryIntent: (event) => onHistoryIntent(event),
      onRequestEnd,
    });
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
    const sentinel = await waitForElement(container, ".chat-history-sentinel");
    const thread = requireElement(container, ".chat-thread", "chat thread");

    expect(sentinel.querySelector("button")).toBeNull();
    thread.dispatchEvent(new WheelEvent("wheel", { deltaY: -1, bubbles: true }));
    thread.dispatchEvent(new KeyboardEvent("keydown", { key: "PageUp", bubbles: true }));
    expect(onBoundaryRead).toHaveBeenCalledTimes(2);

    renderChatInto(container, {
      ...props,
      messages: [...props.messages, { role: "assistant", content: "Updated history" }],
    });
    expect(container.querySelector(".chat-history-sentinel")).toBe(sentinel);
    expect(thread.contains(sentinel)).toBe(true);
    thread.dispatchEvent(new WheelEvent("wheel", { deltaY: -1, bubbles: true }));
    expect(onBoundaryRead).toHaveBeenCalledTimes(3);
    const end = new KeyboardEvent("keydown", { key: "End", bubbles: true, cancelable: true });
    thread.dispatchEvent(end);
    expect(end.defaultPrevented).toBe(true);
    expect(onRequestEnd).toHaveBeenCalledOnce();
    expect(onBoundaryRead).toHaveBeenCalledTimes(3);

    renderChatInto(container, { messages: props.messages, onHistoryIntent });
    expect(container.querySelector(".chat-history-sentinel")).toBeNull();
    expect(thread.contains(sentinel)).toBe(false);
  });
});
