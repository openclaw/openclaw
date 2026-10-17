/* @vitest-environment jsdom */

import { afterEach, expect, it, vi } from "vitest";
import {
  createNativeShowEarlierPane,
  nativeHistoryMessage,
  nativeHistorySeq,
} from "./chat-pane-history.test-support.ts";

function setup(notifyOnObserve = false) {
  const request = vi.fn(async (_method: string, params: { offset: number }) => ({
    messages: [nativeHistoryMessage(-params.offset)],
    hasMore: true,
    nextOffset: params.offset + 1,
  }));
  const fixture = createNativeShowEarlierPane(request);
  const { pane, thread } = fixture;
  const sentinel = thread.appendChild(document.createElement("div"));
  sentinel.className = "chat-history-sentinel";
  let height = 400;
  Object.defineProperty(thread, "scrollHeight", { configurable: true, get: () => height });
  let notify: (() => void) | undefined;
  class HistoryObserver {
    readonly root: Element | Document | null;
    constructor(callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
      this.root = options?.root ?? null;
      notify = () =>
        callback(
          [{ isIntersecting: true } as IntersectionObserverEntry],
          this as unknown as IntersectionObserver,
        );
    }
    observe() {
      if (notifyOnObserve) {
        notify?.();
      }
    }
    disconnect() {}
  }
  vi.stubGlobal("IntersectionObserver", HistoryObserver);
  return {
    ...fixture,
    request,
    setHeight: (value: number) => {
      height = value;
    },
    intersect: async () => {
      pane.syncHistoryObserver();
      notify?.();
      // Join the production load rather than waiting on timers.
      if (pane.history.loadingOlder) {
        await pane.loadOlderMessages();
      }
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("fills a settled short window without input, stopping beyond the prefetch edge", async () => {
  const { intersect, pane, state, request, setHeight } = setup();
  await intersect();
  expect(state.chatMessages.map(nativeHistorySeq)).toEqual([-2, 3, 4]);
  setHeight(900);
  await intersect();
  expect(state.chatMessages.map(nativeHistorySeq)).toEqual([-3, -2, 3, 4]);
  setHeight(1800);
  await intersect();
  expect(request.mock.calls.map(([, params]) => params.offset)).toEqual([2, 3]);
  expect(pane.stagedOlder.page).toBeNull();
  expect(pane.stagedOlder.load).toBeNull();
});

it("caps automatic requests at three pages and renews the allowance for another open", async () => {
  const { intersect, pane, request } = setup();
  for (let index = 0; index < 5; index += 1) {
    await intersect();
  }
  expect(request.mock.calls.map(([, params]) => params.offset)).toEqual([2, 3, 4]);
  pane.resetOlderMessagesViewport();
  await intersect();
  expect(request.mock.calls.map(([, params]) => params.offset)).toEqual([2, 3, 4, 5]);
});

it("does not bootstrap a first page that already overflows", async () => {
  const { intersect, request, setHeight } = setup();
  setHeight(501);
  await intersect();
  expect(request).not.toHaveBeenCalled();
});

it("keeps a bounded snapshot refill for reader intent even in a short settled window", async () => {
  vi.useFakeTimers();
  const { intersect, pane, state, thread, request } = setup(true);
  state.chatHistoryPagination = { hasMore: true, nextOffset: 0, totalMessages: 1_100 };
  request.mockResolvedValue({ messages: [nativeHistoryMessage(1)], hasMore: false, nextOffset: 1 });
  try {
    await intersect();
    await intersect();
    expect(request).not.toHaveBeenCalled();
    expect(state.chatHistoryPagination).toEqual({
      hasMore: true,
      nextOffset: 0,
      totalMessages: 1_100,
    });
    thread.addEventListener("wheel", (event) => pane.handleTranscriptHistoryIntent(event));
    thread.dispatchEvent(new WheelEvent("wheel", { deltaY: -100 }));
    await pane.loadOlderMessages();
    expect(request).toHaveBeenCalledOnce();
    expect(request.mock.calls[0]?.[1].offset).toBe(0);
  } finally {
    pane.resetOlderMessagesViewport();
    vi.useRealTimers();
  }
});

it.each([
  "placement",
  "programmatic",
  "maintenance",
  "hidden",
  "unpresented",
  "background tab",
] as const)("does not fill during %s, including queued intersection delivery", async (gate) => {
  const { pane, request, intersect } = setup();
  // Install an observer first so the notification can also arrive after hiding.
  pane.syncHistoryObserver();
  if (gate === "placement") {
    vi.spyOn(pane.transcript, "isPositionSettled", "get").mockReturnValue(false);
  }
  if (gate === "programmatic") {
    vi.spyOn(pane.transcript, "isProgrammaticScroll", "get").mockReturnValue(true);
  }
  if (gate === "maintenance") {
    vi.spyOn(pane.transcript, "isMaintenanceScroll", "get").mockReturnValue(true);
  }
  if (gate === "hidden") {
    pane.visuallyPresented = false;
  }
  if (gate === "background tab") {
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
  }
  if (gate === "unpresented") {
    vi.spyOn(pane, "presented", "get").mockReturnValue(false);
  }
  await intersect();
  expect(request).not.toHaveBeenCalled();
});

it("keeps a failed automatic fill blocked until reader retry", async () => {
  const { intersect, pane, request } = setup();
  request.mockRejectedValue(new Error("history unavailable"));
  await intersect();
  await intersect();
  expect(request).toHaveBeenCalledOnce();
  expect(pane.historyAutoLoadBlocked).toBe(true);
});

it("stops filling when older history is exhausted", async () => {
  const { intersect, request } = setup();
  request.mockResolvedValue({ messages: [nativeHistoryMessage(1)], hasMore: false, nextOffset: 3 });
  await intersect();
  await intersect();
  expect(request).toHaveBeenCalledOnce();
});

it("pages on reader intent when an overflowing first page already intersects the margin", async () => {
  vi.useFakeTimers();
  const { pane, thread, request, setHeight, intersect } = setup(true);
  request.mockResolvedValue({ messages: [nativeHistoryMessage(1)], hasMore: false, nextOffset: 3 });
  setHeight(501);
  try {
    await intersect();
    expect(request).not.toHaveBeenCalled();
    thread.addEventListener("wheel", (event) => pane.handleTranscriptHistoryIntent(event));
    thread.dispatchEvent(new WheelEvent("wheel", { deltaY: -100 }));
    expect(request).toHaveBeenCalledOnce();
    await pane.loadOlderMessages();
    expect(request.mock.calls[0]?.[1].offset).toBe(2);
  } finally {
    pane.resetOlderMessagesViewport();
    vi.useRealTimers();
  }
});
