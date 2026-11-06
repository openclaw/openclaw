/* @vitest-environment jsdom */

import { afterEach, beforeEach, expect, it, onTestFinished, vi } from "vitest";
import "./chat-pane.tsx";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { createTestChatPane, nativeHistoryMessage } from "./chat-pane-history.test-support.ts";
import { createChatThreadHarness } from "./components/chat-message-native.test-support.tsx";
import type { ChatThreadProps } from "./components/chat-thread-interactions.ts";
import {
  publishTranscriptScroll,
  subscribeTranscriptScroll,
} from "./components/chat-transcript-scroll-events.ts";
import {
  flushDeferredRowPrune,
  installTranscriptDomMocks,
  requireElement,
  resetTranscriptTestDom,
  threadProps,
} from "./components/chat-transcript.test-support.ts";
import { getChatSessionScrollPosition, handleChatScroll } from "./scroll.ts";
import { contact } from "./test-helpers/chat-transcript-native.tsx";

beforeEach(installTranscriptDomMocks);
afterEach(resetTranscriptTestDom);

async function nativeHistoryPane(overrides: Partial<ChatThreadProps> = {}) {
  const request = vi.fn().mockResolvedValue({ messages: [] });
  const { pane, state } = createTestChatPane({
    client: { request } as unknown as GatewayBrowserClient,
  });
  state.chatMessages = [395, 396, 397].map((seq) => nativeHistoryMessage(seq));
  state.chatHistoryPagination = {
    hasMore: true,
    olderCursor: "before-395",
    hasNewer: true,
    newerCursor: "after-794",
  };
  state.chatHasAutoScrolled = true;
  state.handleChatScroll = (scroll) => handleChatScroll(state, scroll);
  const newer = vi.spyOn(pane, "loadNewerMessages").mockResolvedValue(true);
  const older = vi.spyOn(pane, "loadOlderMessages").mockResolvedValue(true);
  const container = document.body.appendChild(document.createElement("div"));
  const view = createChatThreadHarness(container, pane.transcript);
  onTestFinished(() => {
    view.unmount();
    pane.transcript.dispose();
    container.remove();
  });
  // Mount the actual thread: its ref/delegated handlers are established
  // before the virtualizer's queued native observer attachment.
  view.render(
    threadProps(pane.paneId, state.sessionKey, state.chatMessages, {
      ...overrides,
      onHistoryIntent: (event) => pane.handleTranscriptHistoryIntent(event),
    }),
  );
  await flushDeferredRowPrune();
  const thread = requireElement(container, ".chat-thread");
  let height = 62_000;
  Object.defineProperties(thread, {
    clientHeight: { configurable: true, value: 746 },
    scrollHeight: { configurable: true, get: () => height },
  });
  const offsets: Array<{ delta: number; programmatic: boolean }> = [];
  onTestFinished(
    subscribeTranscriptScroll(thread, (event) => {
      if (event.type === "offset") {
        offsets.push({ delta: event.delta, programmatic: event.programmatic });
      }
    }),
  );
  const native = (offset: number) => {
    thread.scrollTop = offset;
    thread.dispatchEvent(new Event("scroll"));
  };
  const correctRange = (before: number, after: number, nextHeight: number) => {
    height = nextHeight;
    thread.scrollTop = after;
    publishTranscriptScroll(thread, {
      type: "resize",
      viewport: { scrollTop: after, clientHeight: 746, scrollHeight: height },
      scrollCorrection: { before, after },
    });
  };
  thread.dispatchEvent(new PointerEvent("pointerdown"));
  native(0);
  expect(pane.transcript.isProgrammaticScroll).toBe(false);
  return { pane, state, thread, request, newer, older, offsets, native, correctRange };
}

it("uses native reader direction after a newer window remaps the physical offset", async () => {
  const { pane, state, thread, newer, older, offsets, native, correctRange } =
    await nativeHistoryPane();
  native(60_879);
  expect(newer).toHaveBeenCalledOnce();
  expect(pane.historyObserverArmed).toBe(false);
  correctRange(60_879, 51, 55_755);
  expect(thread.scrollTop).toBe(51);
  expect(pane.transcript.isProgrammaticScroll).toBe(true);
  native(551);
  // The installed observer knows this is genuine downward movement, although
  // the old pane coordinate is still 60879 in a different resident window.
  expect(offsets.at(-1)).toEqual({ delta: 500, programmatic: false });
  expect(pane.transcript.isMaintenanceScroll).toBe(false);
  expect(newer).toHaveBeenCalledOnce();
  expect(older).not.toHaveBeenCalled();
  expect(pane.historyObserverArmed).toBe(false);
  expect(state.chatLastScrollTop).toBe(551);
});

it("pages from boundary wheel input after takeover clears an old maintenance receipt", async () => {
  const { pane, thread, newer, older, correctRange } = await nativeHistoryPane();
  correctRange(60_879, 1_200, 1_946);
  expect(pane.transcript.isProgrammaticScroll).toBe(true);
  expect(thread.scrollTop).toBe(1_200);
  thread.dispatchEvent(new WheelEvent("wheel", { deltaY: 40 }));
  expect(pane.transcript.isProgrammaticScroll).toBe(false);
  // At the physical end there need not be any native offset event.
  expect(thread.scrollTop).toBe(1_200);
  expect(older).not.toHaveBeenCalled();
  expect(newer).toHaveBeenCalledOnce();
});

it("keeps one native snapshot when a generic subscriber remaps geometry", async () => {
  const { pane, state, thread, newer, native, correctRange } = await nativeHistoryPane();
  native(60_879);
  correctRange(60_879, 51, 55_755);
  onTestFinished(
    subscribeTranscriptScroll(thread, (event) => {
      if (event.type === "offset" && event.delta === 500) {
        thread.scrollTop = 20;
        Object.defineProperty(thread, "scrollHeight", { configurable: true, value: 2_000 });
      }
    }),
  );
  native(551);
  expect(thread.scrollTop).toBe(20);
  expect(state.chatLastScrollTop).toBe(551);
  expect(state.chatLastScrollHeight).toBe(55_755);
  expect(getChatSessionScrollPosition(pane.paneId, state.sessionKey)?.scrollTop).toBe(551);
  expect(pane.historyObserverArmed).toBe(false);
  expect(newer).toHaveBeenCalledOnce();
});

it("distinguishes an owned echo from genuine upward native movement", async () => {
  const { pane, state, newer, native, correctRange } = await nativeHistoryPane();
  state.chatFollowLocked = false;
  state.chatReadingHistory = false;
  correctRange(0, 551, 55_755);
  native(551);
  expect(pane.transcript.isMaintenanceScroll).toBe(true);
  expect(pane.historyObserverArmed).toBe(false);
  expect(state.chatFollowLocked).toBe(false);
  native(511);
  expect(pane.transcript.isMaintenanceScroll).toBe(false);
  expect(pane.historyObserverArmed).toBe(true);
  expect(state.chatFollowLocked).toBe(true);
  expect(state.chatReadingHistory).toBe(true);
  expect(newer).not.toHaveBeenCalled();
});

it("keeps boundary keys after takeover and delegated link ownership", async () => {
  const openFile = vi.fn();
  const { pane, thread, newer, correctRange } = await nativeHistoryPane({
    onOpenWorkspaceFile: openFile,
  });
  correctRange(60_879, 1_200, 1_946);
  const link = thread.appendChild(document.createElement("a"));
  link.dataset.filePath = "README.md";
  link.href = "#file";
  const space = new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true });
  link.dispatchEvent(space);
  expect(space.defaultPrevented).toBe(true);
  expect(openFile).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ path: "README.md" }));
  expect(newer).not.toHaveBeenCalled();
  expect(pane.transcript.isProgrammaticScroll).toBe(false);
  thread.dispatchEvent(
    new KeyboardEvent("keydown", { key: "PageDown", bubbles: true, cancelable: true }),
  );
  expect(newer).toHaveBeenCalledOnce();
});

it("pages a boundary touch gesture without inventing native movement", async () => {
  const { thread, newer, older, correctRange } = await nativeHistoryPane();
  correctRange(60_879, 1_200, 1_946);
  const start = contact(1, thread);
  thread.dispatchEvent(new TouchEvent("touchstart", { touches: [start], changedTouches: [start] }));
  const moved = Object.assign({}, start, { clientY: 60 });
  thread.dispatchEvent(new TouchEvent("touchmove", { touches: [moved], changedTouches: [moved] }));
  expect(thread.scrollTop).toBe(1_200);
  expect(newer).toHaveBeenCalledOnce();
  expect(older).not.toHaveBeenCalled();
  thread.dispatchEvent(new TouchEvent("touchend", { changedTouches: [moved] }));
});

it.each(["nested control", "prevented input"] as const)(
  "preserves %s ownership before boundary paging",
  async (kind) => {
    const { thread, newer, older, correctRange } = await nativeHistoryPane();
    correctRange(60_879, 1_200, 1_946);
    const target =
      kind === "nested control" ? thread.appendChild(document.createElement("textarea")) : thread;
    const event = new WheelEvent("wheel", { deltaY: 40, bubbles: true, cancelable: true });
    if (kind === "prevented input") {
      event.preventDefault();
    }
    target.dispatchEvent(event);
    expect(newer).not.toHaveBeenCalled();
    expect(older).not.toHaveBeenCalled();
  },
);
