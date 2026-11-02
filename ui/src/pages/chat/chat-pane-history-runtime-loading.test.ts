/* @vitest-environment jsdom */

import { expect, it, vi } from "vitest";
import { collectGarbageForTest } from "../../test-helpers/garbage-collection.ts";
import { createChatHistoryPageRead } from "./chat-history-request.ts";
import { chatHistoryRequests } from "./chat-history-state.ts";
import { loadChatHistory } from "./chat-history.ts";
import {
  createStagedPrefetchPane,
  historyPage,
  nativeHistoryMessage,
  nativeHistorySeq,
  stagedPagesRequest,
} from "./chat-pane-history.test-support.ts";

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
  const refreshRequest = vi.fn(async (_method: string, params: { cursor?: string }) => {
    expect(params.cursor).toBeUndefined();
    return historyPage([9, 10], { hasMore: false });
  });
  const refreshed = createStagedPrefetchPane(refreshRequest);
  const oldRead = refreshed.pane.loadOlderMessages();

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
    expect(refreshed.pane.history.loadingOlder).toBe(true);
    expect(autofill.pane.history.loadingOlder).toBe(true);
    expect(retired.pane.history.loadingOlder).toBe(false);
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
  } finally {
    loadingRuntime.release.resolve();
    await Promise.allSettled([
      oldRead,
      retired.pending,
      obsoleteDirection,
      newDirection,
      fill,
      staged.pending,
    ]);
  }
});
