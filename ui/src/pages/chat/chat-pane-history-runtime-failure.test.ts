/* @vitest-environment jsdom */

import { expect, it, vi } from "vitest";
import { loadOlderChatHistoryPage } from "./chat-history-request.ts";
import { createStagedPrefetchPane, stagedPagesRequest } from "./chat-pane-history.test-support.ts";

const loadingRuntime = vi.hoisted(() => ({
  attempts: 0,
  started: Promise.withResolvers<void>(),
  release: Promise.withResolvers<void>(),
}));

vi.mock("./chat-pane-history-packets.runtime.ts", async (original) => {
  const attempt = ++loadingRuntime.attempts;
  loadingRuntime.started.resolve();
  await loadingRuntime.release.promise;
  if (attempt === 1) {
    throw new Error("Paging module unavailable");
  }
  return original<typeof import("./chat-pane-history-packets.runtime.ts")>();
});

it("reports a cold module failure for both paging directions without issuing history reads", async () => {
  const olderRequest = stagedPagesRequest();
  const older = createStagedPrefetchPane(olderRequest);
  const newerRequest = stagedPagesRequest();
  const newer = createStagedPrefetchPane(newerRequest);
  newer.state.chatHistoryPagination = {
    ...newer.state.chatHistoryPagination,
    hasNewer: true,
    newerCursor: "newer-9",
  };
  const wireRequest = stagedPagesRequest();
  const wire = createStagedPrefetchPane(wireRequest);
  const wireRead = loadOlderChatHistoryPage(wire.state, { cursor: "older-2" }).catch(
    (error: unknown) => error,
  );
  const pending = [older.pane.loadOlderMessages(), newer.pane.loadNewerMessages()];
  try {
    await loadingRuntime.started.promise;
    expect(olderRequest).not.toHaveBeenCalled();
    expect(newerRequest).not.toHaveBeenCalled();
    expect(wireRequest).not.toHaveBeenCalled();
    loadingRuntime.release.resolve();
    await expect(Promise.all(pending)).resolves.toEqual([false, false]);
    await expect(wireRead).resolves.toMatchObject({
      cause: new Error("Paging module unavailable"),
    });
    expect(wireRequest).not.toHaveBeenCalled();
    expect(older.pane.history.olderError).toContain("Paging module unavailable");
    expect(older.pane.historyAutoLoadBlocked).toBe(true);
    expect(older.pane.history.loadingOlder).toBe(false);
    expect(newer.state.lastError).toContain("Paging module unavailable");
    expect(newer.pane.history.olderError).toBeNull();
    expect(loadingRuntime.attempts).toBe(1);
    await expect(older.pane.loadOlderMessages(false)).resolves.toBe(true);
    expect(loadingRuntime.attempts).toBe(2);
    expect(olderRequest).toHaveBeenCalledOnce();
    expect(older.pane.history.olderError).toBeNull();
  } finally {
    loadingRuntime.release.resolve();
    await Promise.allSettled([...pending, wireRead]);
  }
});
