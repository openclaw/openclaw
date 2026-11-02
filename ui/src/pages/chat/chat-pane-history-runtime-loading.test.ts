/* @vitest-environment jsdom */

import { expectDefined } from "@openclaw/normalization-core";
import { expect, it, onTestFinished, vi } from "vitest";
import { collectGarbageForTest } from "../../test-helpers/garbage-collection.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { flush, waitForSolid } from "../../test-helpers/solid-settle.ts";
import {
  createChatHistoryPageRead,
  loadOlderChatHistoryPage,
  requestOlderChatHistoryPage,
} from "./chat-history-request.ts";
import { chatHistoryRequests } from "./chat-history-state.ts";
import { loadChatHistory, restoreChatHistoryBookmark } from "./chat-history.ts";
import {
  createStagedPrefetchPane,
  historyPage,
  nativeHistoryMessage,
  nativeHistorySeq,
  stagedPagesRequest,
} from "./chat-pane-history.test-support.ts";
import { buildMessageItems } from "./chat-thread-items.ts";
import { stubAnimationFrames } from "./chat-view.test-helpers.ts";
import { createChatTranscript } from "./components/chat-transcript-controller.ts";
import {
  installTranscriptDomMocks,
  resetTranscriptTestDom,
} from "./components/chat-transcript.test-support.ts";
import { saveChatSessionScrollPosition, type ChatReadingBookmark } from "./scroll.ts";
import {
  mountTestTranscript,
  numberedContentRows,
} from "./test-helpers/chat-transcript-native.tsx";

const loadingRuntime = vi.hoisted(() => ({
  attempts: 0,
  started: Promise.withResolvers<void>(),
  release: Promise.withResolvers<void>(),
}));

vi.mock("./chat-pane-history-packets.runtime.ts", async (original) => {
  loadingRuntime.attempts++;
  loadingRuntime.started.resolve();
  await loadingRuntime.release.promise;
  return original<typeof import("./chat-pane-history-packets.runtime.ts")>();
});

async function coldBookmark(paneId: string) {
  const target = { ...nativeHistoryMessage(1), __openclaw: { id: paneId, seq: 1 } };
  const request = vi.fn(async () => ({
    messages: [target],
    sessionId: "cold-session",
    hasMore: false,
  }));
  const { state } = createStagedPrefetchPane(request);
  state.currentSessionId = "cold-session";
  const saved = {
    sessionId: "cold-session",
    source: `id:${paneId}`,
    messageId: paneId,
    messageKey: expectDefined(buildMessageItems([target])[0], "bookmark message").key,
    rowKey: null,
    offset: -25,
  };
  saveChatSessionScrollPosition(paneId, `agent:main:${paneId}`, {
    scrollTop: 420,
    anchorToEnd: false,
    bookmark: saved,
  });
  let presented = true;
  let lifetime = new AbortController();
  const results: Array<Promise<boolean | undefined>> = [];
  const restore = vi.fn((bookmark: ChatReadingBookmark, isCurrent: () => boolean) => {
    const pending = restoreChatHistoryBookmark(state, bookmark, isCurrent, lifetime.signal);
    results.push(pending);
    void pending.then((restored) => {
      if (restored) {
        view.session.syncMessageRows(
          new Map([[saved.messageId, "row:4"]]),
          new Map([[saved.messageKey, "row:4"]]),
        );
        view.renderRows(numberedContentRows(20));
      }
    });
    return pending;
  });
  const transcript = createChatTranscript(() => paneId, {
    getSessionId: () => state.currentSessionId ?? null,
    canRestoreBookmark: () => presented,
    restoreBookmark: restore,
  });
  const view = await mountTestTranscript(paneId, numberedContentRows(20), transcript);
  view.session.layout.ready = true;
  transcript.update();
  await waitForSolid(() => expect(restore).toHaveBeenCalledOnce());
  return {
    request,
    state,
    target,
    transcript,
    view,
    restore,
    saved,
    result: () => expectDefined(results.at(-1), "bookmark attempt"),
    hide: () => {
      presented = false;
      lifetime.abort();
      lifetime = new AbortController();
    },
    show: () => {
      presented = true;
      transcript.update();
      view.renderRows(numberedContentRows(20));
    },
  };
}

function heldStagedBody() {
  const request = stagedPagesRequest();
  const fixture = createStagedPrefetchPane(request);
  const read = createChatHistoryPageRead(fixture.state, true)!;
  const body = nativeHistoryMessage(5, "Private staged body");
  const weak = new WeakRef(body);
  Object.assign(fixture.pane.stagedHistory, {
    direction: "older",
    page: {
      claim: read.claim,
      requestedCursor: "older-2",
      result: { ...historyPage([5, 6]), messages: [body], hasMore: false },
    },
  });
  const pending = fixture.pane.loadOlderMessages(false);
  return { ...fixture, request, weak, pending };
}

it("keeps cold paging claims fenced and releases retired staged bodies before module delivery", async () => {
  installTranscriptDomMocks();
  const frames = stubAnimationFrames();
  onTestFinished(resetTranscriptTestDom);
  const hiddenBookmark = await coldBookmark("cold-hidden");
  const rapidBookmark = await coldBookmark("cold-rapid");
  const refreshRequest = vi.fn(async (_method: string, params: { cursor?: string }) => {
    expect(params.cursor).toBeUndefined();
    return historyPage([9, 10], { hasMore: false });
  });
  const refreshed = createStagedPrefetchPane(refreshRequest);
  const oldRead = refreshed.pane.loadOlderMessages();

  const abortedRequest = vi.fn();
  const aborted = createStagedPrefetchPane(abortedRequest);
  const abort = new AbortController();
  const reason = new Error("Cancelled bounded read");
  const abortedRead = loadOlderChatHistoryPage(
    aborted.state,
    { cursor: "older-2" },
    abort.signal,
  ).catch((error: unknown) => error);
  const staleRequest = vi.fn();
  const stale = createStagedPrefetchPane(staleRequest);
  let ownsAround = true;
  const staleRead = loadOlderChatHistoryPage(
    stale.state,
    { messageId: "stale-target", sessionId: "cold-session" },
    new AbortController().signal,
    () => ownsAround,
  );
  const bookmarkRequest = vi.fn();
  const bookmark = createStagedPrefetchPane(bookmarkRequest);
  bookmark.state.currentSessionId = "cold-session";
  const bookmarkAbort = new AbortController();
  const bookmarkRead = restoreChatHistoryBookmark(
    bookmark.state,
    {
      sessionId: "cold-session",
      source: "id:bookmark-target",
      messageId: "bookmark-target",
      messageKey: "bookmark-target",
      rowKey: null,
      offset: 0,
    },
    () => true,
    bookmarkAbort.signal,
  );
  const hiddenReplyRequest = vi.fn();
  const hiddenReply = createStagedPrefetchPane(hiddenReplyRequest);
  hiddenReply.state.currentSessionId = "cold-session";
  const hiddenReplyRead = hiddenReply.pane.openReplyMessage("hidden-target");
  const replyRequest = vi.fn(async (_method: string, params: { messageId?: string }) => ({
    messages: [{ ...nativeHistoryMessage(1), __openclaw: { id: params.messageId, seq: 1 } }],
    sessionId: "cold-session",
    hasMore: false,
  }));
  const reply = createStagedPrefetchPane(replyRequest);
  reply.state.currentSessionId = "cold-session";
  vi.spyOn(reply.pane, "updateComplete", "get").mockReturnValue(Promise.resolve(true));
  const reveal = vi.spyOn(reply.pane.transcript, "revealMessage").mockReturnValue(true);
  const oldReply = reply.pane.openReplyMessage("obsolete-target");
  const currentReply = reply.pane.openReplyMessage("current-target");
  const heldRequest = vi.fn(async () => historyPage([1], { hasMore: false }));
  let ownsHeld = true;
  const heldRead = requestOlderChatHistoryPage(
    createTestGatewayClient(heldRequest),
    refreshed.state.sessionKey,
    undefined,
    {
      messageId: "held-target",
      sessionId: "cold-session",
      continuity: { cursor: "held-cursor", activeLeafEntryId: "held-leaf" },
    },
    () => ownsHeld,
    new AbortController().signal,
  );

  const retired = heldStagedBody();
  const reversing = createStagedPrefetchPane(
    vi.fn(async (_method: string, params: { cursor?: string }) => {
      expect(params.cursor).toBe("newer-9");
      return historyPage([9, 10], { hasMore: true, olderCursor: "older-8" });
    }),
  );
  reversing.state.chatHistoryPagination = {
    ...reversing.state.chatHistoryPagination,
    hasNewer: true,
    newerCursor: "newer-9",
  };
  const obsoleteDirection = reversing.pane.loadOlderMessages();
  const newDirection = reversing.pane.loadNewerMessages();

  const autofillRequest = stagedPagesRequest();
  const autofill = createStagedPrefetchPane(autofillRequest);
  const fill = autofill.pane.loadOlderMessages(false);
  const staged = heldStagedBody();
  try {
    await loadingRuntime.started.promise;
    hiddenBookmark.hide();
    rapidBookmark.hide();
    rapidBookmark.show();
    await expect(hiddenBookmark.result()).resolves.toBeUndefined();
    hiddenBookmark.view.renderRows(numberedContentRows(20));
    frames();
    flush();
    expect(hiddenBookmark.restore).toHaveBeenCalledOnce();
    expect(hiddenBookmark.request).not.toHaveBeenCalled();
    await waitForSolid(() => expect(rapidBookmark.restore).toHaveBeenCalledTimes(2));
    expect(rapidBookmark.request).not.toHaveBeenCalled();
    hiddenBookmark.show();
    await waitForSolid(() => expect(hiddenBookmark.restore).toHaveBeenCalledTimes(2));
    expect(refreshed.pane.history.loadingOlder).toBe(true);
    expect(autofill.pane.history.loadingOlder).toBe(true);
    expect(retired.pane.history.loadingOlder).toBe(false);
    expect(loadingRuntime.attempts).toBe(1);
    // One code download serves wire and pane callers; cancelling one owns no cache.
    abort.abort(reason);
    bookmarkAbort.abort();
    hiddenReply.pane.presented = false;
    ownsAround = false;
    ownsHeld = false;
    await expect(abortedRead).resolves.toBe(reason);
    await expect(bookmarkRead).resolves.toBeUndefined();
    await hiddenReplyRead;
    await oldReply;
    expect(abortedRequest).not.toHaveBeenCalled();
    expect(bookmarkRequest).not.toHaveBeenCalled();
    expect(hiddenReplyRequest).not.toHaveBeenCalled();
    expect(replyRequest).not.toHaveBeenCalled();
    expect(heldRequest).not.toHaveBeenCalled();
    expect(loadingRuntime.attempts).toBe(1);
    expect(chatHistoryRequests(refreshed.state).historyVersion).toBeGreaterThan(0);
    await loadChatHistory(refreshed.state, { supersedeInFlight: true });
    const refreshVersion = chatHistoryRequests(refreshed.state).historyVersion;

    // Retirement must settle even if the shared module download never finishes.
    retired.pane.presented = false;
    await expect(retired.pending).resolves.toBe(false);
    await expect(obsoleteDirection).resolves.toBe(false);
    expect(retired.request).not.toHaveBeenCalled();
    expect(retired.pane.history.olderError).toBeNull();
    const control = new WeakRef({ unowned: true });
    await collectGarbageForTest();
    expect(control.deref()).toBeUndefined();
    expect(retired.weak.deref()).toBeUndefined();
    expect(autofillRequest).not.toHaveBeenCalled();
    expect(staged.request).not.toHaveBeenCalled();

    loadingRuntime.release.resolve();
    await expect(staleRead).resolves.toBeUndefined();
    await expect(heldRead).resolves.toEqual({});
    expect(staleRequest).not.toHaveBeenCalled();
    expect(heldRequest).not.toHaveBeenCalled();
    await currentReply;
    await expect(hiddenBookmark.result()).resolves.toBe(true);
    await expect(rapidBookmark.result()).resolves.toBe(true);
    expect(hiddenBookmark.request).toHaveBeenCalledOnce();
    expect(rapidBookmark.request).toHaveBeenCalledOnce();
    expect(hiddenBookmark.state.chatMessages).toEqual([hiddenBookmark.target]);
    expect(rapidBookmark.state.chatMessages).toEqual([rapidBookmark.target]);
    expect(hiddenBookmark.restore.mock.calls[1]?.[0]).toBe(hiddenBookmark.saved);
    expect(rapidBookmark.restore.mock.calls[1]?.[0]).toBe(rapidBookmark.saved);
    expect(replyRequest).toHaveBeenCalledExactlyOnceWith(
      "chat.history",
      expect.objectContaining({ messageId: "current-target" }),
      { signal: expect.any(AbortSignal) },
    );
    expect(reveal).toHaveBeenCalledExactlyOnceWith("current-target");
    await expect(oldRead).resolves.toBe(false);
    expect(chatHistoryRequests(refreshed.state).historyVersion).toBe(refreshVersion);
    expect(refreshed.state.chatMessages.map(nativeHistorySeq)).toEqual([9, 10]);
    expect(refreshRequest).toHaveBeenCalledOnce();
    await expect(newDirection).resolves.toBe(true);
    expect(reversing.state.chatMessages.map(nativeHistorySeq)).toEqual([7, 8, 9, 10]);
    await expect(fill).resolves.toBe(true);
    expect(autofillRequest.mock.calls.map(([, params]) => params.cursor)).toEqual(["older-2"]);
    expect(autofill.pane.stagedHistory).toMatchObject({ page: null, load: null });
    await expect(staged.pending).resolves.toBe(true);
    expect(staged.request).not.toHaveBeenCalled();
    expect(staged.state.chatMessages.map(nativeHistorySeq)).toEqual([5, 7, 8]);

    // A resolved implementation enters the existing request synchronously.
    const before = autofillRequest.mock.calls.length;
    const warm = autofill.pane.loadOlderMessages(false);
    expect(autofillRequest).toHaveBeenCalledTimes(before + 1);
    await expect(warm).resolves.toBe(true);
    const directRequest = stagedPagesRequest();
    const direct = createStagedPrefetchPane(directRequest);
    const warmWire = loadOlderChatHistoryPage(direct.state, { cursor: "older-2" });
    expect(directRequest).toHaveBeenCalledOnce();
    await warmWire;
  } finally {
    loadingRuntime.release.resolve();
    hiddenBookmark.transcript.dispose();
    rapidBookmark.transcript.dispose();
    await Promise.allSettled([
      oldRead,
      abortedRead,
      staleRead,
      bookmarkRead,
      hiddenReplyRead,
      oldReply,
      currentReply,
      heldRead,
      retired.pending,
      obsoleteDirection,
      newDirection,
      fill,
      staged.pending,
    ]);
  }
});
