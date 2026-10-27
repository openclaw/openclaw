/* @vitest-environment jsdom */

import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, expect, it, onTestFinished, vi } from "vitest";
import { flush } from "../../test-helpers/solid-settle.ts";
import {
  createGatewayBrowserClientFixture,
  createInitializationContext,
} from "./chat-application-context.test-support.ts";
import { nativeHistoryMessage } from "./chat-pane-history.test-support.ts";
import { createRenderTestChatPane, type TestChatPane } from "./chat-pane.test-support.ts";
import { subscribeTranscriptScroll } from "./components/chat-transcript-scroll-events.ts";
import {
  installTranscriptDomMocks,
  resetTranscriptTestDom,
  resizeObservers,
  transcriptDomState,
} from "./components/chat-transcript.test-support.ts";
import { render, renderChatThread } from "./test-helpers/chat-transcript-native.tsx";

beforeEach(installTranscriptDomMocks);
afterEach(() => {
  // Disconnect the real pane while its observers and timers still exist.
  document.body.replaceChildren();
  vi.useRealTimers();
  resetTranscriptTestDom();
});

it.each(["idle measurement", "end-command measurement", "native end clamp"] as const)(
  "does not request older history or take reader ownership after %s",
  async (movement) => {
    transcriptDomState.measuredRowHeight = 120;
    // Startup frames and the scroll idle debounce must share the controlled clock.
    vi.useFakeTimers();
    let maximum = 800;
    const nativeScrollHeight = Object.getOwnPropertyDescriptor(Element.prototype, "scrollHeight")!;
    // Both the pane and the explicit thread mount need their real scroll range
    // before the initial intersection can decide whether this is a short page.
    vi.spyOn(Element.prototype, "scrollHeight", "get").mockImplementation(function (this: Element) {
      return this.classList.contains("chat-thread")
        ? maximum + 600
        : nativeScrollHeight.get!.call(this);
    });
    const context = createInitializationContext();
    context.config.subscribe = () => () => {};
    const pane = createRenderTestChatPane();
    // Independent scenarios must not restore the previous case's cached reader.
    pane.paneId = `maintenance-history-${movement}`;
    pane.presentationId = pane.paneId;
    pane.sessionKey = `agent:main:maintenance-history-${movement}`;
    pane.initialize(context);
    document.body.append(pane.element);
    await pane.updateComplete;
    // Connect normally: the pane lifecycle must supply the scroll-policy owners.
    const state = (pane as unknown as TestChatPane).state;
    state.sessionKey = pane.sessionKey;
    const request = vi.fn(async () => ({
      messages: [nativeHistoryMessage(1), nativeHistoryMessage(2)],
      hasMore: false,
      totalMessages: 4,
    }));
    state.client = createGatewayBrowserClientFixture({ request });
    state.connected = true;
    state.chatMessages = Array.from({ length: 12 }, (_, index) => nativeHistoryMessage(index + 3));
    state.chatHistoryPagination = { hasMore: true, nextOffset: 2, totalMessages: 4 };
    state.chatLoading = false;
    state.chatHasAutoScrolled = true;
    pane.render();
    const props = expectDefined(pane.chatProps, "rendered pane callbacks");
    const host = document.body.appendChild(document.createElement("div"));
    onTestFinished(() => render(null, host));
    // The production thread owns geometry updates; the pane only supplies policy callbacks.
    render(renderChatThread(props, props.transcript), host);
    await vi.advanceTimersByTimeAsync(0);
    flush();
    const transcript = props.transcript;
    const container = expectDefined(transcript.scrollElement, "mounted transcript scrollport");
    Object.defineProperties(container, {
      clientHeight: { configurable: true, value: 600 },
      scrollHeight: { configurable: true, get: () => maximum + 600 },
    });
    container.scrollTo = (options?: ScrollToOptions | number) => {
      if (typeof options === "object") {
        container.scrollTop = Math.max(0, Math.min(options.top ?? container.scrollTop, maximum));
      }
    };
    transcript.update();
    for (const observer of resizeObservers) {
      observer.emitTarget(container, 800, 600);
    }
    let scrolling: boolean | undefined;
    const stopObserving = subscribeTranscriptScroll(container, (event) => {
      if (event.type === "offset") {
        scrolling = event.scrolling;
      }
    });
    // Establish a settled end command before exercising maintenance above it.
    flush();
    vi.advanceTimersToNextFrame();
    flush();
    expect(transcript.scrollToEnd({ behavior: "instant" })).toBe(true);
    expect(container.scrollTop).toBe(800);
    expect(transcript.isPositionSettled).toBe(true);
    container.dispatchEvent(new Event("scroll"));

    class HistoryIntersectionObserver {
      constructor(private readonly callback: IntersectionObserverCallback) {}
      observe() {
        this.callback(
          [{ isIntersecting: true } as IntersectionObserverEntry],
          this as unknown as IntersectionObserver,
        );
      }
      disconnect() {}
    }
    vi.stubGlobal("IntersectionObserver", HistoryIntersectionObserver);
    await vi.advanceTimersByTimeAsync(150);
    stopObserving();
    expect(scrolling).toBe(false);
    expect(request).not.toHaveBeenCalled();
    expect(state.chatFollowLocked).toBe(false);
    maximum = 1400;

    if (movement === "native end clamp") {
      // The browser clamps the current position as the scroll range shrinks,
      // before viewport observation or any JavaScript scroll write.
      maximum = 760;
      container.scrollTop = maximum;
    } else {
      if (movement === "end-command measurement") {
        maximum = 800;
        expect(transcript.scrollToEnd({ behavior: "auto" })).toBe(true);
        expect(container.scrollTop).toBe(800);
      }
      // TanStack compensates a remeasured row wholly above the viewport, also
      // while an end command is waiting for its native completion notification.
      const earlier = expectDefined(
        container.querySelector<HTMLElement>('[data-index="4"]'),
        "measured row above the viewport",
      );
      Object.defineProperty(earlier, "offsetHeight", { configurable: true, value: 80 });
      for (const observer of resizeObservers) {
        observer.emitTarget(earlier, 800, 80);
      }
    }
    expect(container.scrollTop).toBe(760);
    container.dispatchEvent(new Event("scroll"));
    await vi.advanceTimersByTimeAsync(0);
    expect.soft(request).not.toHaveBeenCalled();
    expect.soft(state.chatFollowLocked).toBe(false);
    expect.soft(state.chatReadingHistory).toBe(false);

    // Native movement without a classified key (e.g. focus navigation) still
    // owns reader intent after leaving the maintenance target.
    container.scrollTop = 720;
    container.dispatchEvent(new Event("scroll"));
    await vi.advanceTimersByTimeAsync(0);
    expect(request).toHaveBeenCalledExactlyOnceWith(
      "chat.history",
      {
        sessionKey: state.sessionKey,
        limit: 1000,
        maxBytes: 3 * 1024 * 1024,
        toolResultMaxChars: 2_000,
        offset: 2,
      },
      { signal: expect.any(AbortSignal) },
    );
    expect(state.chatFollowLocked).toBe(true);
    expect(state.chatReadingHistory).toBe(true);
  },
);
