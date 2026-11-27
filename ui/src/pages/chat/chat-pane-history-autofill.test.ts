/* @vitest-environment jsdom */

import { afterEach, expect, it, vi } from "vitest";
import type { ChatHistoryResult } from "./chat-history-snapshot.ts";
import {
  createNativeShowEarlierPane,
  nativeHistoryMessage,
  nativeHistorySeq,
} from "./chat-pane-history.test-support.ts";

const page = (seq: number, nextOffset: number, hasMore = true): ChatHistoryResult => ({
  messages: [nativeHistoryMessage(seq)],
  hasMore,
  ...(hasMore ? { olderCursor: `older-${nextOffset}` } : {}),
});

function setup() {
  const request = vi.fn(async (_method: string, { cursor }: { cursor: string }) =>
    page(-Number(cursor.replace("older-", "")), Number(cursor.replace("older-", "")) + 1),
  );
  const fixture = createNativeShowEarlierPane(request);
  const { pane, thread } = fixture;
  let height = 400;
  Object.defineProperty(thread, "scrollHeight", { configurable: true, get: () => height });
  return {
    ...fixture,
    request,
    setHeight: (value: number) => {
      height = value;
    },
    evaluate: async () => {
      pane.evaluateHistoryEdge();
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
  const { evaluate, pane, state, request, setHeight } = setup();
  for (let index = 0; index < 5; index += 1) {
    await evaluate();
  }
  expect(state.chatMessages.map(nativeHistorySeq)).toEqual([-2, 3, 4]);
  for (const height of [900, 1800]) {
    setHeight(height);
    await evaluate();
    expect(state.chatMessages.map(nativeHistorySeq)).toEqual([-2, 3, 4]);
  }
  expect(request.mock.calls.map(([, params]) => params.cursor)).toEqual(["older-2"]);
  expect(pane.stagedOlder).toMatchObject({ page: null, load: null });
  pane.resetOlderMessagesViewport();
  setHeight(400);
  await evaluate();
  expect(request.mock.calls.map(([, params]) => params.cursor)).toEqual(["older-2", "older-3"]);
});

it.each(["isPositionSettled", "visuallyPresented", "presented", "visibilityState"] as const)(
  "does not fill when %s blocks it",
  async (key) => {
    const { pane, request, evaluate } = setup();
    if (key === "visibilityState") {
      vi.spyOn(document, key, "get").mockReturnValue("hidden");
    } else if (key === "visuallyPresented") {
      pane.visuallyPresented = false;
    } else if (key === "presented") {
      vi.spyOn(pane, key, "get").mockReturnValue(false);
    } else {
      vi.spyOn(pane.transcript, key, "get").mockReturnValue(false);
    }
    await evaluate();
    expect(request).not.toHaveBeenCalled();
  },
);

it.each(["failure", "exhaustion"] as const)("stops automatic fills after %s", async (outcome) => {
  const { evaluate, pane, request } = setup();
  if (outcome === "failure") {
    request.mockRejectedValue(new Error("history unavailable"));
  } else {
    request.mockResolvedValue(page(1, 3, false));
  }
  await evaluate();
  await evaluate();
  expect(request).toHaveBeenCalledOnce();
  if (outcome === "failure") {
    expect(pane.historyAutoLoadBlocked).toBe(true);
  }
});

it("reopens a trimmed cache boundary before its single automatic fill", async () => {
  const { pane, state, request, evaluate } = setup();
  state.currentSessionId = "current";
  state.chatMessages[0] = { ...nativeHistoryMessage(3), __openclaw: { id: "source-3", seq: 3 } };
  state.chatHistoryPagination = { hasMore: true, needsBoundary: true, totalMessages: 4 };
  request
    .mockResolvedValueOnce({
      messages: [state.chatMessages[0]],
      sessionId: "current",
      hasMore: true,
      olderCursor: "older-2",
    })
    .mockResolvedValueOnce({ ...page(1, 3), sessionId: "current" });
  await evaluate();
  await evaluate();
  expect(state.chatMessages.map(nativeHistorySeq)).toEqual([1, 3, 4]);
  expect(request.mock.calls.map(([, params]) => params)).toMatchObject([
    { messageId: "source-3", sessionId: "current", limit: 1 },
    { cursor: "older-2", limit: 1000 },
  ]);
  expect(pane.stagedOlder).toMatchObject({ page: null, load: null });
});

it("reserves an overflowing first page for reader intent", async () => {
  vi.useFakeTimers();
  const { pane, state, thread, request, setHeight, evaluate } = setup();
  const pagination = { hasMore: true as const, olderCursor: "older-2", totalMessages: 4 };
  state.chatHistoryPagination = { ...pagination };
  request.mockResolvedValue(page(1, 3, false));
  setHeight(501);
  try {
    await evaluate();
    expect(request).not.toHaveBeenCalled();
    expect(state.chatHistoryPagination).toEqual(pagination);
    thread.addEventListener("wheel", (event) => pane.handleTranscriptHistoryIntent(event));
    thread.dispatchEvent(new WheelEvent("wheel", { deltaY: -100 }));
    expect(request).toHaveBeenCalledOnce();
    await pane.loadOlderMessages();
    expect(request).toHaveBeenCalledOnce();
    expect(request.mock.calls[0]?.[1]).toMatchObject({ cursor: "older-2" });
  } finally {
    pane.resetOlderMessagesViewport();
    vi.useRealTimers();
  }
});
