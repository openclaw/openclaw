/* @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { MAX_CACHED_CHAT_SESSIONS } from "./session-cache.ts";
import {
  appendChatMessageToCache,
  cacheChatSessionSnapshot,
  clearChatMessagesFromCache,
  readChatSessionSnapshot,
  type ChatMessageCache,
  type ChatSessionSnapshot,
} from "./session-message-cache.ts";
import {
  createSessionPrefetchFixture,
  prefetchState,
  prefetchHistoryRequest as historyRequest,
  advanceSessionPrefetch as advancePrefetch,
  PREFETCH_TEST_NOW as NOW,
  prefetchSnapshotHost as snapshotHost,
  prefetchSessionRow as row,
  prefetchHistoryResult as historyResult,
  prefetchSessionKeyFromCall as sessionKeyFromCall,
  settleSessionPrefetch as settlePromises,
  type SessionPrefetchUpdate,
} from "./session-prefetch.test-support.ts";
import { clearStoredChatSnapshots } from "./session-snapshot-invalidation.ts";
import { resolveChatSnapshotKey } from "./session-snapshot-key.ts";
import { SessionSnapshotStore } from "./session-snapshot-store.ts";

const cacheKey = (sessionKey: string) => resolveChatSnapshotKey(snapshotHost, { sessionKey });
function historySnapshot(message: string, sessionId = `session-${message}`): ChatSessionSnapshot {
  return {
    messages: [{ role: "assistant", content: message }],
    pagination: { hasMore: false, completeSnapshot: true },
    sessionId,
  };
}
function expectRequests(request: { mock: { calls: unknown[][] } }, ...keys: string[]) {
  expect(request.mock.calls.map(sessionKeyFromCall)).toEqual(keys);
}

describe("session navigation intent prefetch", () => {
  let fixture: ReturnType<typeof createSessionPrefetchFixture>;
  let cache: ChatMessageCache;
  let store: SessionSnapshotStore;
  let host: ReturnType<typeof createSessionPrefetchFixture>["host"];
  let updatePrefetch: ReturnType<typeof createSessionPrefetchFixture>["updatePrefetch"];

  beforeEach(() => {
    fixture = createSessionPrefetchFixture();
    ({ cache, store, host, updatePrefetch } = fixture);
  });
  afterEach(async () => fixture.dispose());

  const readSnapshot = (sessionKey: string) =>
    readChatSessionSnapshot(cache, snapshotHost, { sessionKey });
  const cacheSnapshot = (sessionKey: string, snapshot: ChatSessionSnapshot) =>
    cacheChatSessionSnapshot(cache, snapshotHost, { sessionKey }, snapshot);
  async function intend(sessionKey: string, delay = 300) {
    fixture.intend(sessionKey);
    await advancePrefetch(delay);
  }
  async function expectStored(sessionKey: string, expected: ChatSessionSnapshot | null) {
    expect(readSnapshot(sessionKey)).toEqual(expected);
    await store.flush();
    expect(await store.read(cacheKey(sessionKey))).toEqual(expected);
  }
  async function holdPrefetch(
    key: string,
    rows = [row(key, NOW - 1)],
    overrides: Partial<SessionPrefetchUpdate> = {},
  ) {
    const response = createDeferred<ReturnType<typeof historyResult>>();
    const request = vi.fn(() => response.promise);
    const snapshot = prefetchState(request, rows, overrides);
    updatePrefetch(snapshot);
    await intend(key);
    expect(request).toHaveBeenCalledOnce();
    return { response, request, snapshot };
  }

  it("keeps unchanged intended history while another session becomes active", async () => {
    const key = "agent:main:report";
    const otherKey = "agent:main:active";
    const queuedKey = "agent:main:queued";
    const unchanged = { ...row(key, NOW - 1), sessionId: `id:${key}` };
    const other = { ...row(otherKey, NOW), hasActiveRun: true };
    const queued = row(queuedKey, NOW - 2);
    const { response, request, snapshot } = await holdPrefetch(key, [unchanged, queued, other], {
      openSessionKeys: [otherKey],
    });

    updatePrefetch({
      ...snapshot,
      listRevision: 2,
      rows: [{ ...unchanged }, { ...queued, hasActiveRun: true }, { ...other, updatedAt: NOW + 1 }],
    });
    response.resolve(historyResult(key));
    await settlePromises();
    expect(readSnapshot(key)?.messages).toEqual(historyResult(key).messages);
    expect(readSnapshot(queuedKey)).toBeNull();
    await store.flush();
    expect((await store.read(cacheKey(key)))?.messages).toEqual(historyResult(key).messages);
    await advancePrefetch(31_000);
    expect(request).toHaveBeenCalledOnce();
  });

  it.each([
    "session removed without a roster revision",
    "session replaced",
    "client replacement",
    "same-client reconnect",
    "session invalidation",
    "profile cache clear",
    "newer pane snapshot",
  ] as const)("rejects a held prefetch after %s", async (change) => {
    const key = "agent:main:owned";
    const original = { ...row(key, NOW - 1), sessionId: "original" };
    const { response, request, snapshot } = await holdPrefetch(key, [original]);

    let expected: ChatSessionSnapshot | null = null;
    if (change === "session removed without a roster revision") {
      updatePrefetch({ ...snapshot, rows: [] });
    } else if (change === "session replaced") {
      updatePrefetch({
        ...snapshot,
        listRevision: 2,
        rows: [{ ...original, sessionId: "replacement" }],
      });
    } else if (change === "client replacement") {
      updatePrefetch({ ...snapshot, client: createTestGatewayClient(request) });
    } else if (change === "same-client reconnect") {
      updatePrefetch({ ...snapshot, client: null });
      updatePrefetch(snapshot);
    } else if (change === "session invalidation") {
      clearChatMessagesFromCache(cache, snapshotHost, { sessionKey: key });
    } else if (change === "profile cache clear") {
      await clearStoredChatSnapshots();
    } else {
      expected = historySnapshot("Newer pane history");
      cacheSnapshot(key, expected);
    }
    response.resolve(historyResult(key));
    await settlePromises();
    await expectStored(key, expected);
  });

  it.each([false, true])(
    "hydrates persisted history and fences its cursor-reset reread (clear during reread: %s)",
    async (clearDuringReread) => {
      const key = "agent:main:persisted";
      cacheSnapshot(key, { ...historySnapshot("Stored history"), deltaCursor: "stored-cursor" });
      await store.flush();
      cache.clear();
      const page = createDeferred<ReturnType<typeof historyResult>>();
      const request = vi.fn(async (_method: string, params: unknown) =>
        (params as { cursor?: string }).cursor
          ? { kind: "reset", reason: "stale-cursor" }
          : page.promise,
      );
      updatePrefetch(prefetchState(request, [row(key, NOW + 1)]));
      await intend(key);
      expect(
        request.mock.calls.map(([, params]) => (params as { cursor?: string }).cursor),
      ).toEqual(["stored-cursor", undefined]);
      if (clearDuringReread) {
        await clearStoredChatSnapshots();
      }
      page.resolve(historyResult(key));
      await settlePromises();
      const snapshot = readSnapshot(key);
      expect(snapshot?.messages ?? null).toEqual(
        clearDuringReread ? null : historyResult(key).messages,
      );
      await store.flush();
      expect(await store.read(cacheKey(key))).toEqual(snapshot);
    },
  );

  it.each(["presented alias", "fresh snapshot", "active run", "full presented cache"])(
    "does not prefetch intent already owned by %s",
    async (owner) => {
      const sessionKey = "agent:main:main";
      const request = historyRequest();
      if (owner === "fresh snapshot") {
        store.write(cacheKey(sessionKey), historySnapshot("fresh"));
        await store.flush();
      }
      updatePrefetch(
        prefetchState(
          request,
          [{ ...row(sessionKey, NOW - 1), hasActiveRun: owner === "active run" }],
          {
            openSessionKeys:
              owner === "presented alias"
                ? ["main"]
                : owner === "full presented cache"
                  ? Array.from(
                      { length: MAX_CACHED_CHAT_SESSIONS },
                      (_, index) => `agent:main:presented-${index}`,
                    )
                  : ["agent:main:foreground"],
          },
        ),
      );
      await intend(sessionKey);

      expect(request).not.toHaveBeenCalled();
    },
  );

  it("defers new intent when a presented transcript starts loading mid-cycle", async () => {
    const response = createDeferred<ReturnType<typeof historyResult>>();
    const request = vi
      .fn(() => createDeferred<ReturnType<typeof historyResult>>().promise)
      .mockReturnValueOnce(response.promise);
    const state = prefetchState(
      request,
      [
        row("agent:main:main", NOW - 1),
        row("agent:main:recent-1", NOW - 2),
        row("agent:main:recent-2", NOW - 3),
      ],
      { openSessionKeys: ["agent:main:main"] },
    );
    updatePrefetch(state);
    await intend("agent:main:recent-1");
    expectRequests(request, "agent:main:recent-1");

    // The user opens another session while the first warm-up is in flight.
    updatePrefetch({ ...state, loadingSessionKeys: ["agent:main:main"] });
    fixture.intend("agent:main:recent-2");
    response.resolve(historyResult("agent:main:recent-1"));
    await settlePromises();
    expectRequests(request, "agent:main:recent-1");

    updatePrefetch({ ...state, loadingSessionKeys: [] });
    host.dispatchEvent(
      new CustomEvent("openclaw-chat-transcript-loading-changed", { bubbles: true }),
    );
    await advancePrefetch(300);
    expectRequests(request, "agent:main:recent-1", "agent:main:recent-2");
  });

  it("rechecks readiness after the persisted snapshot read before requesting history", async () => {
    const sessionKey = "agent:main:stored";
    const stored = historySnapshot("stored", "session-stored");
    store.write(cacheKey(sessionKey), stored);
    await store.flush();
    cache.clear();
    const read = createDeferred<ChatSessionSnapshot | null>();
    const readSpy = vi.spyOn(store, "read").mockReturnValueOnce(read.promise);
    const request = historyRequest();
    const state: SessionPrefetchUpdate = prefetchState(
      request,
      [row("agent:main:main", NOW - 1), row(sessionKey, NOW + 1)],
      { openSessionKeys: ["agent:main:main"] },
    );
    updatePrefetch(state);
    await intend(sessionKey);
    expect(readSpy).toHaveBeenCalledWith(cacheKey(sessionKey));
    expect(request).not.toHaveBeenCalled();

    // The presented pane starts loading while IndexedDB is still answering.
    const pane = host.firstElementChild as HTMLElement & { transcriptLoading: boolean };
    pane.transcriptLoading = true;
    const loadingChanged = () =>
      pane.dispatchEvent(
        new CustomEvent("openclaw-chat-transcript-loading-changed", { bubbles: true }),
      );
    loadingChanged();
    read.resolve(stored);
    await settlePromises();
    expect(request).not.toHaveBeenCalled();

    pane.transcriptLoading = false;
    loadingChanged();
    await advancePrefetch(300);
    expectRequests(request, sessionKey);
  });

  it("preserves presented snapshots while warming intended background sessions", async () => {
    const presentedSessionKey = "agent:main:presented";
    cacheSnapshot(presentedSessionKey, historySnapshot("presented"));
    for (let index = 1; index < MAX_CACHED_CHAT_SESSIONS; index += 1) {
      cacheSnapshot(`agent:main:stale-${index}`, historySnapshot(`stale-${index}`));
    }
    await store.flush();

    const request = historyRequest();
    const client = createTestGatewayClient(request);
    const backgroundRows = Array.from({ length: 3 }, (_, index) =>
      row(`agent:main:background-${index}`, NOW - index - 1),
    );
    const rows = [row(presentedSessionKey, NOW), ...backgroundRows];

    updatePrefetch({ client, listRevision: 1, openSessionKeys: [presentedSessionKey], rows });
    for (const { key } of backgroundRows) {
      await intend(key, 1_000);
      await store.flush();
    }

    expectRequests(request, ...backgroundRows.map(({ key }) => key));
    expect(readSnapshot(presentedSessionKey)).toEqual(historySnapshot("presented"));
    expect(store.readSavedAt(cacheKey(presentedSessionKey))).not.toBeNull();

    expect(store.readSavedAt(cacheKey("agent:main:background-0"))).not.toBeNull();
  });

  it("coalesces list revisions behind cooldown while prioritizing new intent", async () => {
    const warm = "agent:main:warm";
    const intended = "agent:main:intended";
    let firstRequestAt = 0;
    const request = vi.fn(async (_method: string, params: unknown) => {
      firstRequestAt ||= Date.now();
      return historyResult((params as { sessionKey: string }).sessionKey);
    });
    const state = prefetchState(request, [row(warm, NOW - 1), row(intended, NOW - 2)]);
    updatePrefetch(state);
    await intend(warm);
    expectRequests(request, warm);
    await advancePrefetch(4_700);

    const changed = {
      ...state,
      listRevision: 2,
      rows: [row(warm, Date.now()), row(intended, NOW - 2)],
    };
    updatePrefetch(changed);
    updatePrefetch({
      ...changed,
      listRevision: 3,
      rows: [row(warm, Date.now() + 1), row(intended, NOW - 2)],
    });
    await advancePrefetch(1_000);
    expect(request).toHaveBeenCalledOnce();

    await intend(intended, 74);
    expect(request).toHaveBeenCalledOnce();
    await advancePrefetch(1);
    expectRequests(request, warm, intended);

    await advancePrefetch(20_000);
    await intend(warm, 75);
    expect(request).toHaveBeenCalledTimes(2);
    await advancePrefetch(firstRequestAt + 30_000 - Date.now() - 1);
    expect(request).toHaveBeenCalledTimes(2);
    await advancePrefetch(1);
    expectRequests(request, warm, intended, warm);
  });

  it("keeps the first intent deadline across list revisions and pointer sweeps", async () => {
    const request = historyRequest();
    const state = prefetchState(
      request,
      [row("agent:main:swept", NOW), row("agent:main:intended", NOW - 1)],
      {
        hiddenConversationSessionKeys: ["agent:main:foreground"],
      },
    );
    updatePrefetch(state);
    await advancePrefetch(300);
    const target = fixture.intend("agent:main:swept");
    await advancePrefetch(30);
    updatePrefetch({ ...state, listRevision: 2 });
    target.dataset.sessionKey = "agent:main:intended";
    target.dispatchEvent(new Event("pointerover", { bubbles: true }));
    await advancePrefetch(44);
    expect(request).not.toHaveBeenCalled();
    await advancePrefetch(1);
    expectRequests(request, "agent:main:intended");
  });

  it("coalesces intent behind the running request without losing its short schedule", async () => {
    const first = "agent:main:first";
    const intended = "agent:main:intended";
    const response = createDeferred<ReturnType<typeof historyResult>>();
    const request = vi.fn(async (_method: string, params: unknown) =>
      (params as { sessionKey: string }).sessionKey === first
        ? response.promise
        : historyResult(intended),
    );
    const rows = [row(first, NOW - 1)];
    const state = prefetchState(request, rows);
    updatePrefetch(state);
    await intend(first);
    updatePrefetch({ ...state, listRevision: 2, rows: [...rows, row(intended, NOW - 2)] });
    await intend(intended, 100);
    expectRequests(request, first);
    response.resolve(historyResult(first));
    await settlePromises();
    await advancePrefetch(74);
    expect(request).toHaveBeenCalledOnce();
    await advancePrefetch(1);
    expectRequests(request, first, intended);
  });

  it("rewarms complete stored history after an interleaved append miss", async () => {
    const sessionKey = "agent:main:delta";
    const priorMessages = Array.from({ length: 5 }, (_, index) => ({
      role: index % 2 === 0 ? "user" : "assistant",
      content: `prior-${index + 1}`,
      __openclaw: { id: `prior-${index + 1}`, seq: index + 1 },
    }));
    cacheSnapshot(sessionKey, {
      deltaCursor: "cursor-1",
      messages: priorMessages,
      pagination: { hasMore: false, completeSnapshot: true },
      sessionId: "session-delta",
    });
    await store.flush();
    const previousSavedAt = store.readSavedAt(cacheKey(sessionKey));
    cache.clear();
    const liveMessage = {
      role: "user",
      content: "live broadcast",
      __openclaw: { id: "live-user", seq: 6 },
    };
    const liveEvent = {
      sessionKey,
      message: liveMessage,
      messageId: "live-user",
      messageSeq: 6,
    };
    appendChatMessageToCache(cache, snapshotHost, { sessionKey }, liveMessage, liveEvent);
    const deltaMessage = {
      role: "assistant",
      content: [{ type: "toolCall", id: "wait", name: "sessions_yield", arguments: {} }],
      __openclaw: { id: "delta-assistant", seq: 7 },
    };
    const preparedDeltaMessage = { ...deltaMessage, activity: [] };
    const request = vi.fn(async () => ({
      kind: "delta",
      activity: [{ messageId: "delta-assistant", items: [] }],
      messages: [
        liveEvent,
        {
          sessionKey,
          message: deltaMessage,
          messageId: "delta-assistant",
          messageSeq: 7,
        },
      ],
      deltaCursor: "cursor-2",
      sessionInfo: { key: sessionKey, kind: "direct", sessionId: "session-delta", updatedAt: 2 },
    }));

    updatePrefetch(prefetchState(request, [row(sessionKey, NOW + 1)]));
    await intend(sessionKey, 2_000);

    expect(request).toHaveBeenCalledWith(
      "chat.history",
      expect.objectContaining({ cursor: "cursor-1", sessionKey }),
      { signal: expect.any(AbortSignal), timeoutMs: 30_000 },
    );
    const expected = {
      deltaCursor: "cursor-2",
      transcriptMetadata: { key: sessionKey, kind: "direct" },
      messages: [...priorMessages, liveMessage, preparedDeltaMessage],
      pagination: { hasMore: false, completeSnapshot: true },
      sessionId: "session-delta",
    };
    expect(readSnapshot(sessionKey)).toEqual(expected);
    expect(store.readSavedAt(cacheKey(sessionKey))).toBeGreaterThan(previousSavedAt ?? 0);
    await store.flush();
    expect(await new SessionSnapshotStore().read(cacheKey(sessionKey))).toEqual(expected);
  });

  it("retains the prior cursor when a delta carries transient active-run replay", async () => {
    const sessionKey = "agent:main:active";
    cacheSnapshot(sessionKey, {
      deltaCursor: "cursor-1",
      messages: [{ role: "user", content: "cached" }],
      pagination: { hasMore: false, completeSnapshot: true },
      sessionId: "session-active",
    });
    const request = vi.fn(async () => ({
      kind: "delta",
      messages: [],
      deltaCursor: "cursor-2",
      sessionInfo: {
        key: sessionKey,
        kind: "direct",
        sessionId: "session-active",
        updatedAt: 2,
        hasActiveRun: true,
      },
      inFlightRun: {
        runId: "run-active",
        events: [
          {
            runId: "run-active",
            seq: 1,
            stream: "item",
            ts: 1,
            sessionKey,
            data: { kind: "preamble", itemId: "progress", progressText: "Still working" },
          },
        ],
      },
    }));

    updatePrefetch(prefetchState(request, [row(sessionKey, NOW + 1)]));
    await intend(sessionKey, 2_000);

    expect(readSnapshot(sessionKey)?.deltaCursor).toBe("cursor-1");
  });

  it("pauses intent while hidden and resumes when the tab becomes visible", async () => {
    const request = historyRequest();
    updatePrefetch(prefetchState(request, [row("agent:main:hidden", NOW - 1)]));
    fixture.intend("agent:main:hidden");
    fixture.setVisibility("hidden");
    await advancePrefetch(300);

    expect(request).not.toHaveBeenCalled();
    fixture.setVisibility("visible");
    document.dispatchEvent(new Event("visibilitychange"));
    await advancePrefetch(75);
    expectRequests(request, "agent:main:hidden");
  });

  it("does not retry fetch errors or stop later navigation intent", async () => {
    const request = vi.fn(async (_method: string, params: unknown) => {
      const sessionKey = (params as { sessionKey: string }).sessionKey;
      if (sessionKey.endsWith("failed")) {
        throw new Error("prefetch failed");
      }
      return historyResult(sessionKey);
    });
    updatePrefetch(
      prefetchState(request, [
        row("agent:main:failed", NOW - 1),
        row("agent:main:succeeded", NOW - 2),
      ]),
    );

    await intend("agent:main:failed");
    expectRequests(request, "agent:main:failed");
    await intend("agent:main:succeeded");

    expectRequests(request, "agent:main:failed", "agent:main:succeeded");
    expect(readSnapshot("agent:main:succeeded")).not.toBeNull();
    await advancePrefetch(60_000);
    expect(
      request.mock.calls.filter((call) => sessionKeyFromCall(call).endsWith("failed")),
    ).toHaveLength(1);
  });
});
