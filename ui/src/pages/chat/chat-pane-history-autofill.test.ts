/* @vitest-environment jsdom */

import { afterEach, expect, it, vi } from "vitest";
import {
  createNativeShowEarlierPane,
  nativeHistoryMessage,
  nativeHistorySeq,
} from "./chat-pane-history.test-support.ts";

const page = (seq: number, nextOffset: number, hasMore = true) => ({
  messages: [nativeHistoryMessage(seq)],
  hasMore,
  nextOffset,
});

function setup(notifyOnObserve = false) {
  const request = vi.fn(async (_method: string, { offset }: { offset: number }) =>
    page(-offset, offset + 1),
  );
  const fixture = createNativeShowEarlierPane(request);
  const { pane, thread } = fixture;
  const sentinel = thread.appendChild(document.createElement("div"));
  sentinel.className = "chat-history-sentinel";
  pane.historySentinel = sentinel;
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
    observe = notifyOnObserve ? () => notify?.() : () => {};
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

it("fills one page until reopened, without filling the prefetch margin", async () => {
  const { intersect, pane, state, request, setHeight } = setup();
  for (let index = 0; index < 5; index += 1) {
    await intersect();
  }
  expect(state.chatMessages.map(nativeHistorySeq)).toEqual([-2, 3, 4]);
  for (const height of [900, 1800]) {
    setHeight(height);
    await intersect();
    expect(state.chatMessages.map(nativeHistorySeq)).toEqual([-2, 3, 4]);
  }
  expect(request.mock.calls.map(([, params]) => params.offset)).toEqual([2]);
  expect(pane.stagedOlder).toMatchObject({ page: null, load: null });
  pane.resetOlderMessagesViewport();
  setHeight(400);
  await intersect();
  expect(request.mock.calls.map(([, params]) => params.offset)).toEqual([2, 3]);
});

it.each([
  "isPositionSettled",
  "isProgrammaticScroll",
  "isMaintenanceScroll",
  "visuallyPresented",
  "presented",
  "visibilityState",
] as const)("does not fill when %s blocks a queued intersection", async (key) => {
  const { pane, request, intersect } = setup();
  pane.syncHistoryObserver();
  if (key === "visibilityState") {
    vi.spyOn(document, key, "get").mockReturnValue("hidden");
  } else if (key === "visuallyPresented") {
    pane.visuallyPresented = false;
  } else if (key === "presented") {
    vi.spyOn(pane, key, "get").mockReturnValue(false);
  } else {
    vi.spyOn(pane.transcript, key, "get").mockReturnValue(key !== "isPositionSettled");
  }
  await intersect();
  expect(request).not.toHaveBeenCalled();
});

it.each(["failure", "exhaustion"] as const)("stops automatic fills after %s", async (outcome) => {
  const { intersect, pane, request } = setup();
  if (outcome === "failure") {
    request.mockRejectedValue(new Error("history unavailable"));
  } else {
    request.mockResolvedValue(page(1, 3, false));
  }
  await intersect();
  await intersect();
  expect(request).toHaveBeenCalledOnce();
  if (outcome === "failure") {
    expect(pane.historyAutoLoadBlocked).toBe(true);
  }
});

it.each([
  ["bounded snapshot", 0, 400],
  ["overflowing first page", 2, 501],
] as const)("reserves %s refill for reader intent", async (_name, offset, height) => {
  vi.useFakeTimers();
  const { pane, state, thread, request, setHeight, intersect } = setup(true);
  const pagination = { hasMore: true, nextOffset: offset, totalMessages: offset === 0 ? 1_100 : 4 };
  state.chatHistoryPagination = { ...pagination };
  request.mockResolvedValue(page(1, offset + 1, false));
  setHeight(height);
  try {
    await intersect();
    if (offset === 0) {
      await intersect();
    }
    expect(request).not.toHaveBeenCalled();
    expect(state.chatHistoryPagination).toEqual(pagination);
    thread.addEventListener("wheel", (event) => pane.handleTranscriptHistoryIntent(event));
    thread.dispatchEvent(new WheelEvent("wheel", { deltaY: -100 }));
    if (offset === 2) {
      expect(request).toHaveBeenCalledOnce();
    }
    await pane.loadOlderMessages();
    expect(request).toHaveBeenCalledOnce();
    expect(request.mock.calls[0]?.[1].offset).toBe(offset);
  } finally {
    pane.resetOlderMessagesViewport();
    vi.useRealTimers();
  }
});
