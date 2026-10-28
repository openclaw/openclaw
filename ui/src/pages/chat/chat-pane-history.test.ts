/* @vitest-environment jsdom */

import type { UsersMentionableResult } from "@openclaw/gateway-protocol";
import { createComponent, createMemo, merge } from "solid-js";
import { expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { sessionsResult } from "../../lib/sessions/session-capability.test-support.ts";
import { createApplicationContextProvider } from "../../test-helpers/application-context.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { createSolidApplicationContextProvider } from "../../test-helpers/solid-application-context.tsx";
import { flush, waitForSolid } from "../../test-helpers/solid-settle.ts";
import "./chat-pane.tsx";
import { createGatewayBrowserClientFixture } from "./chat-application-context.test-support.ts";
import { handleChatGatewayEvent } from "./chat-gateway.ts";
import type { ChatHistoryPagination } from "./chat-history-pagination.ts";
import type { ChatHistoryResult } from "./chat-history-snapshot.ts";
import { resetChatHistoryProjection } from "./chat-history-state.ts";
import { renderedText } from "./chat-history.inflight.test-support.ts";
import { loadChatHistory } from "./chat-history.ts";
import {
  appendChatThread,
  createNativeShowEarlierPane,
  createRefreshChatPane,
  createStagedPrefetchPane,
  createTestChatPane,
  nativeHistoryMessage,
  nativeHistorySeq,
  stagedPagesRequest,
} from "./chat-pane-history.test-support.ts";
import { applyChatPendingInputs } from "./chat-pending-inputs.ts";
import { createComposerQuestions } from "./components/chat-composer-questions.ts";
import { ChatComposer, resetChatComposerState } from "./components/chat-composer.tsx";
import { ChatHistoryBoundary } from "./components/chat-history-boundary.tsx";
import { reduceChatSessionProjection } from "./history-merge.ts";
import { applySessionMessagePayload } from "./session-message-apply.ts";
import {
  applyChatCacheSnapshot,
  cacheChatSessionSnapshot,
  readChatSessionSnapshot,
} from "./session-message-cache.ts";
import { agentEvent } from "./tool-stream.test-helpers.ts";
import { handleAgentEvent } from "./tool-stream.ts";

type HistoryPageOverrides = {
  totalMessages?: number;
  sessionId?: string;
  sessionInfo?: { sessionId: string };
};

function historyPage(seqs = [1, 2], extra: HistoryPageOverrides = {}) {
  return {
    messages: seqs.map((seq) => nativeHistoryMessage(seq)),
    ...pagination(),
    ...extra,
  };
}

function testPane(request = vi.fn()) {
  return createTestChatPane({ client: { request } as unknown as GatewayBrowserClient });
}

function historyPane(request = vi.fn(async () => historyPage())) {
  const result = testPane(request);
  result.state.chatMessages = historyPage([3, 4]).messages;
  result.state.chatHistoryPagination = { hasMore: true, nextOffset: 2, totalMessages: 4 };
  return { ...result, request };
}

function olderRequest(sessionKey: string, offset = 2) {
  return { sessionKey, limit: 1000, maxBytes: 3 * 1024 * 1024, toolResultMaxChars: 2_000, offset };
}

function pagination(totalMessages = 4, nextOffset?: number): ChatHistoryPagination {
  return nextOffset === undefined
    ? { hasMore: false, totalMessages }
    : { hasMore: true, nextOffset, totalMessages };
}

function installHistoryObserver(intersect = true) {
  const observe = vi.fn();
  const disconnect = vi.fn();
  const construct =
    vi.fn<(callback: IntersectionObserverCallback, observer: IntersectionObserver) => void>();
  let rootMargin: string | undefined;
  class FakeIntersectionObserver {
    readonly root: IntersectionObserver["root"] | undefined;
    constructor(
      private readonly callback: IntersectionObserverCallback,
      options?: IntersectionObserverInit,
    ) {
      rootMargin = options?.rootMargin;
      this.root = intersect ? undefined : (options?.root ?? null);
      construct(callback, this as unknown as IntersectionObserver);
    }
    disconnect() {
      disconnect();
    }
    observe(target: Element) {
      observe(target);
      if (intersect) {
        this.callback(
          [{ isIntersecting: true } as IntersectionObserverEntry],
          this as unknown as IntersectionObserver,
        );
      }
    }
  }
  vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
  onTestFinished(() => {
    vi.unstubAllGlobals();
  });
  return { observe, disconnect, construct, rootMargin: () => rootMargin };
}

function appendSentinel(thread: HTMLElement, pane: { historySentinel: HTMLElement | null }) {
  const sentinel = document.createElement("div");
  sentinel.className = "chat-history-sentinel";
  thread.append(sentinel);
  pane.historySentinel = sentinel;
  return sentinel;
}

it("updates the earlier-history control directly from pane loading state", () => {
  const { pane, state, context } = createRefreshChatPane();
  state.chatHistoryPagination = { hasMore: true, nextOffset: 2 };
  const view = mountSolid(
    () => {
      const history = createMemo(() => {
        pane.render();
        return pane.chatProps!.historyPagination!;
      });
      return createComponent(ChatHistoryBoundary, merge(history));
    },
    { wrapper: createSolidApplicationContextProvider(context).wrapper },
  );
  const button = view.container.querySelector("button")!;
  expect(button.disabled).toBe(false);

  pane.history.loadingOlder = true;
  flush();
  expect(button.getAttribute("aria-disabled")).toBe("true");
  expect(button.getAttribute("aria-busy")).toBe("true");

  pane.history.loadingOlder = false;
  flush();
  expect(button.disabled).toBe(false);
  expect(button.getAttribute("aria-busy")).toBe("false");
});

it("passes only a proven profile viewer identity to transcript rendering", () => {
  const { pane, context } = createRefreshChatPane();
  const user = { id: "collision", name: "Viewer", avatarUrl: "/api/users/collision/avatar" };
  context.gateway.snapshot.selfUser = user;
  pane.render();
  expect(pane.chatProps?.userId).toBeNull();
  context.gateway.snapshot.selfUser = { ...user, identity: { type: "profile", id: "collision" } };
  pane.render();
  expect(pane.chatProps).toMatchObject({ userId: "collision", userAvatar: user.avatarUrl });
});

it.each(["pending", "resolved"] as const)(
  "keeps a %s people query selectable when selected-session metadata hydrates",
  async (replyState) => {
    vi.useFakeTimers();
    const response = createDeferred<UsersMentionableResult>();
    const people: UsersMentionableResult = {
      users: [{ profileId: "profile-bob", displayName: "Bob", online: true }],
      truncated: false,
    };
    const request = vi.fn((_method: string, _params?: unknown) => response.promise);
    const client = createGatewayBrowserClientFixture({
      recoveryScopeReady: true,
      request: (method, params) =>
        method === "users.mentionable" ? request(method, params) : Promise.resolve({}),
    });
    const { pane, state, context } = createRefreshChatPane(client);
    pane.presentationId = `mention-hydration-${replyState}`;
    context.gateway.snapshot.selfUser = {
      id: "profile-alice",
      name: "Alice",
      identity: { type: "profile", id: "profile-alice" },
    };
    state.sessionKey = "agent:main:mention-hydration";
    state.chatRunId = "active-run";
    const send = vi.spyOn(state, "handleSendChat").mockResolvedValue(undefined);
    const container = createApplicationContextProvider(context);
    document.body.append(container);
    let view: ReturnType<typeof mountSolid> | undefined;
    try {
      view = mountSolid(
        () => {
          const current = createMemo(() => {
            pane.render();
            return pane.chatProps!;
          });
          const questions = createComposerQuestions(pane.presentationId, current);
          return createComponent(ChatComposer, merge(current, { questions }));
        },
        { container, wrapper: createSolidApplicationContextProvider(context).wrapper },
      );
      flush();
      const textarea = container.querySelector<HTMLTextAreaElement>("textarea")!;
      for (const character of "@Bo") {
        const input = { bubbles: true, inputType: "insertText", data: character };
        textarea.dispatchEvent(new InputEvent("beforeinput", input));
        textarea.value += character;
        textarea.setSelectionRange(textarea.value.length, textarea.value.length);
        textarea.dispatchEvent(new InputEvent("input", input));
      }
      await vi.advanceTimersByTimeAsync(150);
      await waitForSolid(() =>
        expect(request).toHaveBeenCalledExactlyOnceWith("users.mentionable", {
          sessionKey: state.sessionKey,
          agentId: "main",
          query: "Bo",
        }),
      );
      const selectedName = () =>
        container.querySelector('[role="option"] .slash-menu-name')?.textContent;
      if (replyState === "resolved") {
        response.resolve(people);
        await waitForSolid(() => expect(selectedName()).toBe("Bob"));
      }

      state.sessionsResult = sessionsResult(
        [
          {
            key: state.sessionKey,
            kind: "direct",
            updatedAt: 1,
            sessionId: "hydrated-session",
            visibility: "shared",
            sharingRole: "owner",
          },
        ],
        1,
      );
      response.resolve(people);
      await waitForSolid(() => expect(selectedName()).toBe("Bob"));
      expect(container.querySelector("textarea")).toBe(textarea);
      textarea.dispatchEvent(
        new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Enter" }),
      );
      expect(state.chatMessage).toBe("@Bob ");
      expect(state.chatMentions).toEqual([{ profileId: "profile-bob", start: 0, end: 4 }]);
      expect(send).not.toHaveBeenCalled();
    } finally {
      view?.unmount();
      resetChatComposerState(pane.presentationId);
      container.remove();
      vi.useRealTimers();
    }
  },
);

it("keeps the accepted steer and live tail visible while pane refresh is pending", () => {
  const history = createDeferred<ChatHistoryResult>();
  const request = vi.fn(() => history.promise);
  const client = { request } as unknown as GatewayBrowserClient;
  const { pane, state } = createRefreshChatPane(client);
  state.sessionKey = "agent:main:refresh";
  state.chatRunId = "run-refresh";
  const original = {
    role: "user",
    content: "Start.",
    __openclaw: { id: "original-refresh", idempotencyKey: "run-refresh:user", seq: 1 },
  };
  const steer = {
    role: "user",
    content: "Steer.",
    __openclaw: {
      id: "steer-refresh",
      idempotencyKey: "steer-refresh:user",
      steerTargetRunId: "run-refresh",
      seq: 3,
    },
  };
  state.chatMessages = [original];
  const delta = (text: string) =>
    handleChatGatewayEvent(state, {
      state: "delta",
      runId: "run-refresh",
      sessionKey: state.sessionKey,
      message: { role: "assistant", content: text },
    });
  delta("Saved.");
  applySessionMessagePayload(state, { message: steer }, true, {
    kind: "live",
    activeRunId: "run-refresh",
  });
  delta("Saved. Working.");
  handleAgentEvent(
    state,
    agentEvent(
      "run-refresh",
      1,
      "item",
      {
        itemId: "tool:build",
        toolCallId: "build",
        kind: "tool",
        name: "exec",
        title: "Build the workspace",
        phase: "start",
        status: "running",
      },
      state.sessionKey,
    ),
  );
  const liveExpected = ["Start.", "Steer.", "Saved. Working."];

  try {
    expect(renderedText(state)).toEqual(liveExpected);
    pane.render();
    pane.chatProps!.onRefresh();
    expect(renderedText(state)).toEqual(liveExpected);
    expect([...state.toolStreamById.values()]).toMatchObject([
      {
        toolCallId: "build",
        activity: [{ status: "running" }],
      },
    ]);
  } finally {
    state.connected = false;
    history.resolve({ messages: [] });
  }
});

it("publishes older history with its own cursor after a sibling advances", async () => {
  const request = vi.fn(async () => historyPage([1, 2], { sessionId: "session-id" }));
  const { pane, state } = createNativeShowEarlierPane(request);
  state.chatMessagesBySession = new Map();
  const snapshot = {
    deltaCursor: "delta-cursor",
    messages: state.chatMessages,
    pagination: state.chatHistoryPagination,
    sessionId: "session-id",
  };
  applyChatCacheSnapshot(state, snapshot);
  const key = { sessionKey: state.sessionKey };
  cacheChatSessionSnapshot(state.chatMessagesBySession, state, key, {
    ...snapshot,
    deltaCursor: "sibling-cursor",
    messages: [...state.chatMessages, nativeHistoryMessage(5)],
  });
  await pane.loadOlderMessages();
  expect(readChatSessionSnapshot(state.chatMessagesBySession, state, key)).toMatchObject({
    ...snapshot,
    messages: state.chatMessages,
    pagination: state.chatHistoryPagination,
  });
});

it("preserves terminal ownership when custody retires during an older-page load", async () => {
  const older = createDeferred<ChatHistoryResult>();
  const { pane, state } = createNativeShowEarlierPane(vi.fn(() => older.promise));
  state.currentSessionId = "session-id";
  state.chatMessagesBySession = new Map();
  const tail = [...state.chatMessages];
  const runId = "older-page-delivery";
  reduceChatSessionProjection(state, {
    type: "sendPending",
    runId,
    message: {
      role: "user",
      content: "Accepted input",
      __openclaw: { idempotencyKey: `${runId}:user` },
    },
  });
  const loading = pane.loadOlderMessages();
  handleChatGatewayEvent(state, {
    state: "final",
    runId,
    sessionKey: state.sessionKey,
    message: { role: "assistant", content: "Delivered reply" },
  });
  const terminal = state.chatMessages.at(-1);
  const receipt = { runId, state: "consumed" as const, consumedByEventId: "collected-turn" };
  applyChatPendingInputs(state, { items: [], total: 0 }, { receipts: [receipt] });
  const prefix = [nativeHistoryMessage(1), nativeHistoryMessage(2)];
  older.resolve({ messages: prefix, hasMore: false, sessionId: "session-id", totalMessages: 4 });
  await loading;
  expect(state.chatMessages).toEqual([...prefix, ...tail, terminal]);
  expect(
    readChatSessionSnapshot(state.chatMessagesBySession, state, { sessionKey: state.sessionKey })
      ?.messages,
  ).toEqual(state.chatMessages);
  reduceChatSessionProjection(state, { type: "snapshotLoaded", messages: [...prefix, ...tail] });
  expect(state.chatMessages).toEqual([...prefix, ...tail, terminal]);
});

it("reveals a final catalog page even when its cursor is exhausted", async () => {
  const request = vi.fn(async () => ({
    hostId: "gateway:local",
    threadId: "thread-1",
    items: [{ id: "u1", type: "userMessage", text: "oldest catalog message" }],
  }));
  const { pane, state } = testPane(request);
  const key = "catalog:claude:gateway%3Alocal:thread-1";
  Object.defineProperty(pane, "isConnected", { configurable: true, value: false });
  state.sessionKey = key;
  pane.sessionKey = key;
  pane.history.catalogCursor = "final-page";
  Object.defineProperty(pane, "isConnected", { configurable: true, value: true });
  appendChatThread(pane);
  vi.spyOn(pane, "updateComplete", "get").mockReturnValue(Promise.resolve(true));
  const scrollToOffset = vi.spyOn(pane.transcript, "scrollToOffset");

  await pane.loadOlderMessages();

  expect(request).toHaveBeenCalledWith(
    "sessions.catalog.read",
    expect.objectContaining({ cursor: "final-page" }),
    { signal: expect.any(AbortSignal) },
  );
  expect(pane.history.catalogMessages).toHaveLength(1);
  expect(pane.history.catalogCursor).toBeUndefined();
  expect(scrollToOffset).not.toHaveBeenCalled();
});

it("keeps a failed older load blocked across a layout-induced scroll", async () => {
  const request = vi.fn().mockRejectedValue(new Error("history unavailable"));
  const { pane, thread } = createNativeShowEarlierPane(request);
  pane.transcriptScrollTop = 500;

  await pane.loadOlderMessages();
  pane.handleTranscriptScroll({ currentTarget: thread, target: thread } as unknown as Event);

  expect(pane.historyAutoLoadBlocked).toBe(true);
  expect(request).toHaveBeenCalledOnce();
});

it.each(["empty", "overlapping"])(
  "continues past an %s older page within one reader action",
  async (kind) => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        messages: kind === "empty" ? [] : [nativeHistoryMessage(3)],
        hasMore: true,
        nextOffset: 4,
        totalMessages: 6,
      })
      .mockResolvedValueOnce({
        messages: [nativeHistoryMessage(1), nativeHistoryMessage(2)],
        hasMore: false,
        totalMessages: 6,
      });
    const { pane, state } = createNativeShowEarlierPane(request);
    await pane.loadOlderMessages();
    expect(state.chatMessages.map(nativeHistorySeq)).toEqual([1, 2, 3, 4]);
    expect(state.chatHistoryPagination.hasMore).toBe(false);
  },
);

it("keeps a retry outcome when a tail refresh retires an earlier-history action", async () => {
  const held = createDeferred<ChatHistoryResult>();
  const request = vi
    .fn()
    .mockImplementationOnce(() => held.promise)
    .mockResolvedValue({ ...historyPage([3, 4], { sessionId: "current" }), ...pagination(4, 2) });
  const { pane, state } = createNativeShowEarlierPane(request);
  const older = pane.loadOlderMessages();
  const tail = loadChatHistory(state);
  pane.syncHistoryObserver();
  await tail;
  held.resolve({ messages: historyPage().messages, hasMore: false, totalMessages: 4 });
  await older;
  expect(pane.history.olderError).toContain("refreshed");
  expect(state.chatMessages.map(nativeHistorySeq)).toEqual([3, 4]);
});

it("joins an in-flight canonical load without commanding a viewport jump", async () => {
  const deferred = createDeferred<ReturnType<typeof historyPage>>();
  const request = vi.fn(() => deferred.promise);
  const { pane, scrollToOffset } = createNativeShowEarlierPane(request);

  const automaticLoad = pane.loadOlderMessages();
  const manualNavigation = pane.loadOlderMessages();
  deferred.resolve(historyPage());
  await Promise.all([automaticLoad, manualNavigation]);

  expect(request).toHaveBeenCalledOnce();
  expect(scrollToOffset).not.toHaveBeenCalled();
});

it.each(["resolved", "rejected"])(
  "does not apply a %s older read to a replacement session",
  async (outcome) => {
    const older = createDeferred<ChatHistoryResult>();
    const { pane, state, scrollToOffset } = createNativeShowEarlierPane(vi.fn(() => older.promise));
    const loading = pane.loadOlderMessages();
    state.sessionKey = "agent:main:replacement";
    state.chatMessages = [];
    if (outcome === "resolved") {
      older.resolve({ messages: [nativeHistoryMessage(1)], hasMore: false, totalMessages: 1 });
    } else {
      older.reject(new Error("Obsolete history read failed"));
    }
    await loading;
    expect(state.chatMessages).toEqual([]);
    expect(pane.history.olderError).toBeNull();
    expect(scrollToOffset).not.toHaveBeenCalled();
  },
);

it("fills a visible history tail once the viewport can fit it", async () => {
  const { pane, state, request } = historyPane();
  const thread = document.createElement("div");
  thread.className = "chat-thread";
  Object.defineProperty(thread, "scrollHeight", { value: 400 });
  let clientHeight = 0;
  Object.defineProperty(thread, "clientHeight", { get: () => clientHeight });
  const sentinel = appendSentinel(thread, pane);
  pane.append(thread);
  vi.spyOn(pane.transcript, "scrollElement", "get").mockReturnValue(thread);
  const { observe } = installHistoryObserver();
  pane.syncHistoryObserver();
  expect(request).not.toHaveBeenCalled();
  clientHeight = 200;
  pane.syncHistoryObserver();
  clientHeight = 600;
  pane.syncHistoryObserver();
  await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
  expect(observe).toHaveBeenCalledWith(sentinel);
  await vi.waitFor(() => expect(state.chatMessages.map(nativeHistorySeq)).toEqual([1, 2, 3, 4]));
});

it.each(["initial placement", "programmatic reveal"])(
  "does not arm history from an upward offset during %s",
  (placement) => {
    const { pane } = createTestChatPane({ client: createGatewayBrowserClientFixture() });
    vi.spyOn(pane.transcript, "isPositionSettled", "get").mockReturnValue(
      placement !== "initial placement",
    );
    vi.spyOn(pane.transcript, "isProgrammaticScroll", "get").mockReturnValue(
      placement === "programmatic reveal",
    );
    const thread = appendChatThread(pane, { scrollTop: 80 });
    pane.transcriptScrollTop = 100;
    const event = new Event("scroll");
    Object.defineProperty(event, "target", { value: thread });
    pane.handleTranscriptScroll(event);
    expect(pane.historyObserverArmed).toBe(false);
  },
);

it("prefetches older history from upward intent well before the top edge", async () => {
  const { pane, state, request } = historyPane();
  state.handleChatScroll = vi.fn();
  const thread = appendChatThread(pane, { scrollHeight: 4_000, clientHeight: 600 });
  appendSentinel(thread, pane);
  const observer = installHistoryObserver();
  pane.transcriptScrollTop = 900;
  thread.scrollTop = 800;
  const event = new Event("scroll");
  Object.defineProperty(event, "target", { value: thread });
  pane.handleTranscriptScroll(event);
  await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
  expect(request).toHaveBeenCalledWith("chat.history", olderRequest(state.sessionKey), {
    signal: expect.any(AbortSignal),
  });
  expect(observer.rootMargin()).toBe("1200px 0px 0px");
});

it("joins an in-flight prefetch instead of duplicating the request", async () => {
  const deferred = createDeferred<unknown>();
  const request = stagedPagesRequest({ 4: () => deferred.promise });
  const { pane, state } = createStagedPrefetchPane(request);

  await pane.loadOlderMessages();
  await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));

  const joined = pane.loadOlderMessages();
  deferred.resolve(historyPage([3, 4], { totalMessages: 8 }));
  await expect(joined).resolves.toBe(true);

  expect(request.mock.calls.filter(([, params]) => params.offset === 4)).toHaveLength(1);
  expect(state.chatMessages.map(nativeHistorySeq)).toEqual([3, 4, 5, 6, 7, 8]);
});

it("uses the refreshed continuation when a joined prefetch becomes stale", async () => {
  const held = createDeferred<unknown>();
  const pages = stagedPagesRequest({
    4: () => held.promise,
    5: () => ({ ...historyPage([1, 2], { totalMessages: 9, sessionId: "current" }) }),
  });
  const request = vi.fn((method, params: { offset?: number }) =>
    params.offset === undefined
      ? Promise.resolve({
          ...historyPage([7, 8, 9], { totalMessages: 9, sessionId: "current" }),
          ...pagination(9, 5),
        })
      : pages(method, params),
  );
  const { pane, state } = createStagedPrefetchPane(request);
  await pane.loadOlderMessages();
  const joined = pane.loadOlderMessages();
  await loadChatHistory(state);
  held.resolve(historyPage([3, 4], { totalMessages: 8 }));
  await expect(joined).resolves.toBe(true);
  expect(state.chatMessages.map(nativeHistorySeq)).toEqual([1, 2, 7, 8, 9]);
  expect(request).toHaveBeenLastCalledWith(
    "chat.history",
    olderRequest(state.sessionKey, 5),
    expect.anything(),
  );
});

it.each([
  { change: "cursor moves", offset: 5, total: 9, seqs: [31, 32], reset: false },
  { change: "same-cursor projection resets", offset: 4, total: 8, seqs: [41, 42], reset: true },
])("discards a staged page when the $change", async (row) => {
  let reads = 0;
  const replacement = row.seqs.map((seq) =>
    nativeHistoryMessage(seq, seq === 41 ? "post-rewind branch" : undefined),
  );
  const request = stagedPagesRequest({
    [row.offset]: () => ({
      ...historyPage([], { totalMessages: row.total }),
      messages:
        ++reads === 1 && row.reset
          ? [nativeHistoryMessage(3, "pre-rewind branch"), nativeHistoryMessage(4)]
          : replacement,
    }),
  });
  const { pane, state } = createStagedPrefetchPane(request);
  await pane.loadOlderMessages();
  await vi.waitFor(() => expect(pane.stagedOlder.page).not.toBeNull());
  if (row.reset) {
    resetChatHistoryProjection(state);
  }
  state.chatHistoryPagination = pagination(row.total, row.offset);
  await expect(pane.loadOlderMessages()).resolves.toBe(true);
  expect(request).toHaveBeenLastCalledWith(
    "chat.history",
    olderRequest(state.sessionKey, row.offset),
    { signal: expect.any(AbortSignal) },
  );
  expect(reads).toBe(row.reset ? 2 : 1);
  const expectedTail = row.reset ? [] : historyPage([5, 6, 7, 8]).messages;
  expect(state.chatMessages).toEqual([...replacement, ...expectedTail]);
});

it("keeps prefetch failures silent and retries reactively", async () => {
  const nextPage = vi
    .fn()
    .mockRejectedValueOnce(new Error("prefetch boom"))
    .mockReturnValue(historyPage([3, 4], { totalMessages: 8 }));
  const request = stagedPagesRequest({ 4: nextPage });
  const { pane, state } = createStagedPrefetchPane(request);

  await pane.loadOlderMessages();
  await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
  await vi.waitFor(() => expect(pane.stagedOlder.load).toBeNull());

  expect(state.lastError).toBeNull();
  await expect(pane.loadOlderMessages()).resolves.toBe(true);
  expect(nextPage).toHaveBeenCalledTimes(2);
  expect(state.chatMessages.map(nativeHistorySeq)).toEqual([3, 4, 5, 6, 7, 8]);
});

it("reuses an armed history observer and ignores its queued callback after reset", async () => {
  const request = vi.fn();
  const { pane, state } = testPane(request);
  state.chatHistoryPagination = { hasMore: true, nextOffset: 2, totalMessages: 4 };
  pane.historyObserverArmed = true;
  const thread = appendChatThread(pane, { scrollHeight: 400, clientHeight: 200 });
  const sentinel = appendSentinel(thread, pane);
  const { observe, disconnect, construct } = installHistoryObserver(false);
  pane.syncHistoryObserver();
  pane.syncHistoryObserver();
  expect(construct).toHaveBeenCalledOnce();
  expect(observe).toHaveBeenCalledExactlyOnceWith(sentinel);
  expect(disconnect).not.toHaveBeenCalled();
  pane.resetOlderMessagesViewport();
  const [notify, observer] = construct.mock.calls[0]!;
  notify([{ isIntersecting: true } as IntersectionObserverEntry], observer);
  await Promise.resolve();
  expect(request).not.toHaveBeenCalled();
});

it("deduplicates projected catalog transcript records by catalog message id", () => {
  const { pane } = testPane();
  const [current, overlapping] = ["newer projection", "older projection"].map((text) =>
    pane.catalogItemMessage({ id: "catalog-item-1", type: "userMessage", text }),
  );
  if (!current || !overlapping) {
    throw new Error("expected catalog transcript projections");
  }
  pane.history.catalogMessages = [current];

  expect(pane.prependUniqueCatalogMessages([overlapping])).toEqual([current]);
});

it("prepends a strictly older page and exhausts", async () => {
  const { pane, state, request } = historyPane();
  await pane.loadOlderMessages();

  expect(state.chatMessages.map(nativeHistorySeq)).toEqual([1, 2, 3, 4]);
  expect(state.chatHistoryPagination).toEqual({ hasMore: false, totalMessages: 4 });
  expect(state.lastError).toBeNull();
  expect(pane.hasOlderMessages()).toBe(false);

  await pane.loadOlderMessages();
  expect(request).toHaveBeenCalledExactlyOnceWith("chat.history", olderRequest(state.sessionKey), {
    signal: expect.any(AbortSignal),
  });
});

it("replaces cached source groups during a zero-offset refill without losing live rows", async () => {
  const cached = nativeHistoryMessage(3);
  const changed = {
    ...cached,
    __openclaw: {
      ...cached["__openclaw"],
      senderProfileAvatarUrl: "/api/users/synthetic/avatar?v=2",
    },
  };
  const sibling = {
    ...changed,
    content: [{ type: "text", text: "Second projection from the same source" }],
  };
  const unchanged = nativeHistoryMessage(4);
  const live = nativeHistoryMessage(5);
  const request = vi.fn(async () => ({
    ...historyPage(undefined, { sessionId: "session-current" }),
    messages: [nativeHistoryMessage(2), changed, sibling, { ...unchanged }],
  }));
  const { pane, state } = historyPane(request);
  state.currentSessionId = "session-current";
  state.chatMessages = [cached, unchanged];
  reduceChatSessionProjection(state, { type: "messagePersisted", message: live });
  state.chatHistoryPagination = pagination(4, 0);

  await pane.loadOlderMessages();

  expect(state.chatMessages).toEqual([nativeHistoryMessage(2), changed, sibling, unchanged, live]);
  expect(state.chatMessages[3]).toBe(unchanged);
  expect(state.chatMessages[4]).toBe(live);
  expect(request).toHaveBeenCalledExactlyOnceWith(
    "chat.history",
    olderRequest(state.sessionKey, 0),
    { signal: expect.any(AbortSignal) },
  );
});

it("replaces a byte-limited cached tail before loading the next older page", async () => {
  const request = vi
    .fn()
    .mockResolvedValueOnce({ ...historyPage([4, 5]), ...pagination(5, 2) })
    .mockResolvedValueOnce(historyPage([1, 2, 3], { totalMessages: 5 }));
  const { pane, state } = historyPane(request);
  state.chatMessages = historyPage([2, 3, 4, 5]).messages;
  state.chatHistoryPagination = pagination(5, 0);

  await pane.loadOlderMessages();
  expect(state.chatMessages.map(nativeHistorySeq)).toEqual([4, 5]);
  await pane.loadOlderMessages();
  expect(state.chatMessages.map(nativeHistorySeq)).toEqual([1, 2, 3, 4, 5]);
  expect(state.chatHistoryPagination).toEqual(pagination(5));
});

it("refreshes the tail instead of mixing an older page from a replacement session", async () => {
  const extra = { totalMessages: 2, sessionInfo: { sessionId: "session-new" } };
  const request = vi
    .fn()
    .mockResolvedValueOnce(historyPage([1, 2], extra))
    .mockResolvedValueOnce(historyPage([7, 8], extra));
  const { pane, state } = historyPane(request);
  state.currentSessionId = "session-old";

  await pane.loadOlderMessages();

  expect(request).toHaveBeenNthCalledWith(1, "chat.history", olderRequest(state.sessionKey), {
    signal: expect.any(AbortSignal),
  });
  expect(request).toHaveBeenNthCalledWith(
    2,
    "chat.history",
    expect.objectContaining({ sessionKey: state.sessionKey, limit: 80, maxBytes: 256 * 1024 }),
    { signal: expect.any(AbortSignal), timeoutMs: 30_000 },
  );
  expect(state.currentSessionId).toBe("session-new");
  expect(state.chatMessages.map(nativeHistorySeq)).toEqual([7, 8]);
});

it.each([
  { range: "overlapping", tail: [3, 4], total: 4, expected: [1, 2, 3, 4], hasMore: false },
  { range: "disjoint", tail: [7, 8], total: 8, expected: [7, 8], hasMore: true },
])("reconciles a $range refreshed tail for the same backing session", async (row) => {
  const { pane, state } = testPane(
    vi.fn(async () => ({
      ...historyPage(row.tail, { totalMessages: row.total }),
      ...pagination(row.total, 2),
      sessionInfo: { sessionId: "session-current" },
    })),
  );
  state.currentSessionId = "session-current";
  state.chatMessages = historyPage([1, 2, 3, 4]).messages;
  state.chatHistoryPagination = { hasMore: false, totalMessages: 4 };
  await loadChatHistory(state);
  expect(state.chatMessages.map(nativeHistorySeq)).toEqual(row.expected);
  expect(state.chatHistoryPagination).toEqual(pagination(row.total, row.hasMore ? 2 : undefined));
  expect(pane.hasOlderMessages()).toBe(row.hasMore);
});

it.each(["tail", "older"] as const)(
  "replaces a reset window from a %s read and adopts its cursor",
  async (read) => {
    const messages = ["current user", "current reply"].map((text, index) =>
      nativeHistoryMessage(index + 3, text),
    );
    const sessionInfo = { sessionId: "session-current" };
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        messages,
        windowReset: true,
        deltaCursor: "cursor-current",
        ...pagination(4, 2),
        sessionInfo,
      })
      .mockResolvedValueOnce({
        kind: "delta",
        messages: [],
        deltaCursor: "cursor-next",
        sessionInfo,
      });
    const { pane, state } = testPane(request);
    applyChatCacheSnapshot(state, {
      sessionId: "session-current",
      messages: [1, 2, 3, 4].map((seq) => nativeHistoryMessage(seq)),
      pagination: pagination(4, read === "older" ? 2 : undefined),
    });

    await (read === "older" ? pane.loadOlderMessages() : loadChatHistory(state));

    expect(request).toHaveBeenCalledOnce();
    expect(state.chatMessages).toEqual(messages);
    expect(state.chatHistoryPagination).toEqual(pagination(4, 2));
    await loadChatHistory(state);
    expect(request).toHaveBeenLastCalledWith(
      "chat.history",
      expect.objectContaining({ cursor: "cursor-current" }),
      { signal: expect.any(AbortSignal), timeoutMs: 30_000 },
    );
  },
);

it("preserves the older-page cursor when a tail refresh fails", async () => {
  const { state } = testPane(vi.fn().mockRejectedValue(new Error("gateway unavailable")));
  const savedPagination = { hasMore: true as const, nextOffset: 2, totalMessages: 4 };
  state.chatHistoryPagination = savedPagination;

  await loadChatHistory(state);

  expect(state.chatHistoryPagination).toBe(savedPagination);
});
