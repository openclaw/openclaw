/* @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import {
  clearChatMessagesFromCache,
  readChatSessionSnapshot,
  type ChatMessageCache,
} from "./session-message-cache.ts";
import {
  createSessionPrefetchFixture,
  prefetchState,
  advanceSessionPrefetch as advancePrefetch,
  PREFETCH_TEST_NOW as NOW,
  prefetchSnapshotHost as snapshotHost,
  prefetchSessionRow as row,
  prefetchHistoryResult as historyResult,
  prefetchSessionKeyFromCall as sessionKeyFromCall,
  settleSessionPrefetch as settlePromises,
} from "./session-prefetch.test-support.ts";
import { clearStoredChatSnapshots } from "./session-snapshot-invalidation.ts";
import { resolveChatSnapshotKey } from "./session-snapshot-key.ts";
import { SessionSnapshotStore } from "./session-snapshot-store.ts";
const cacheKey = (sessionKey: string) => resolveChatSnapshotKey(snapshotHost, { sessionKey });
describe("prefetch read retirement", () => {
  let fixture: ReturnType<typeof createSessionPrefetchFixture>;
  let cache: ChatMessageCache;
  let store: SessionSnapshotStore;
  let updatePrefetch: ReturnType<typeof createSessionPrefetchFixture>["updatePrefetch"];
  beforeEach(() => {
    fixture = createSessionPrefetchFixture();
    ({ cache, store, updatePrefetch } = fixture);
  });
  afterEach(async () => fixture.dispose());
  it("retires the running reader and keeps the short schedule for new intent", async () => {
    const first = "agent:main:first";
    const intended = "agent:main:intended";
    const response = createDeferred<ReturnType<typeof historyResult>>();
    let signal: AbortSignal | undefined;
    const request = vi.fn(
      (_method: string, params: unknown, options?: { signal?: AbortSignal }) => {
        if ((params as { sessionKey: string }).sessionKey !== first) {
          return Promise.resolve(historyResult(intended));
        }
        signal = options?.signal;
        return response.promise;
      },
    );
    onTestFinished(() => response.resolve(historyResult(first)));
    const state = prefetchState(request, [row(first, NOW - 1), row(intended, NOW - 2)]);
    updatePrefetch(state);
    fixture.intend(first);
    await advancePrefetch(300);
    fixture.intend(intended);
    expect(signal?.aborted).toBe(true);
    await settlePromises();
    await advancePrefetch(74);
    expect(request).toHaveBeenCalledOnce();
    await advancePrefetch(1);
    expect(request.mock.calls.map(sessionKeyFromCall)).toEqual([first, intended]);
    response.resolve(historyResult(first));
    await settlePromises();
    expect(readChatSessionSnapshot(cache, snapshotHost, { sessionKey: first })).toBeNull();
    expect(
      readChatSessionSnapshot(cache, snapshotHost, { sessionKey: intended })?.messages,
    ).toEqual(historyResult(intended).messages);
  });
  it.each([
    "new intent",
    "foreground loading",
    "opened pane",
    "hidden document",
    "disconnect",
    "target invalidation",
    "profile clear",
  ] as const)(
    "retires a held prefetch after %s without following an abandoned cursor reset",
    async (change) => {
      const key = "agent:main:obsolete";
      const response = createDeferred<
        ReturnType<typeof historyResult> | { kind: "reset"; reason: string }
      >();
      let signal: AbortSignal | undefined;
      const snapshot = prefetchState(
        (_method, _params, options) => {
          signal = options?.signal;
          return response.promise;
        },
        [row(key, NOW - 1), row("agent:main:next", NOW - 2)],
      );
      const request = vi.spyOn(snapshot.client!, "request");
      onTestFinished(() => response.resolve(historyResult(key)));
      updatePrefetch(snapshot);
      fixture.intend(key);
      await advancePrefetch(300);
      expect(request).toHaveBeenCalledOnce();

      if (change === "new intent") {
        fixture.intend("agent:main:next");
      } else if (change === "foreground loading") {
        updatePrefetch({ ...snapshot, loadingSessionKeys: snapshot.openSessionKeys });
      } else if (change === "opened pane") {
        updatePrefetch({ ...snapshot, openSessionKeys: [key] });
      } else if (change === "hidden document") {
        fixture.setVisibility("hidden");
        document.dispatchEvent(new Event("visibilitychange"));
      } else if (change === "disconnect") {
        updatePrefetch({ ...snapshot, client: null });
      } else if (change === "target invalidation") {
        clearChatMessagesFromCache(cache, snapshotHost, { sessionKey: key });
      } else {
        await clearStoredChatSnapshots();
      }

      expect(signal?.aborted).toBe(true);
      response.resolve({ kind: "reset", reason: "stale-cursor" });
      await settlePromises();
      expect(request).toHaveBeenCalledOnce();
      expect(readChatSessionSnapshot(cache, snapshotHost, { sessionKey: key })).toBeNull();
      await store.flush();
      expect(await store.read(cacheKey(key))).toBeNull();
    },
  );

  it("keeps a held prefetch when a different session is invalidated", async () => {
    const key = "agent:main:current";
    const response = createDeferred<ReturnType<typeof historyResult>>();
    let signal: AbortSignal | undefined;
    const snapshot = prefetchState(
      (_method, _params, options) => {
        signal = options?.signal;
        return response.promise;
      },
      [row(key, NOW - 1)],
    );
    onTestFinished(() => response.resolve(historyResult(key)));
    updatePrefetch(snapshot);
    fixture.intend(key);
    await advancePrefetch(300);
    clearChatMessagesFromCache(cache, snapshotHost, { sessionKey: "agent:main:other" });
    expect(signal?.aborted).toBe(false);
    response.resolve(historyResult(key));
    await settlePromises();
    expect(readChatSessionSnapshot(cache, snapshotHost, { sessionKey: key })?.messages).toEqual(
      historyResult(key).messages,
    );
  });
});
