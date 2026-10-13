/* @vitest-environment jsdom */
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { requestResult, transactionComplete } from "../../lib/chat/control-ui-database.runtime.ts";
import type { ChatSessionSnapshot } from "./session-message-cache.ts";
import {
  CHAT_SNAPSHOT_METADATA_STORE_NAME,
  CHAT_SNAPSHOT_STORE_NAME,
  openSessionSnapshotDatabase,
  readStoredChatSnapshotRecord,
} from "./session-snapshot-database.ts";
import { SessionSnapshotStore } from "./session-snapshot-store.ts";

const sessionKey = 'scope:["wss://cache.example","account-a"]\u0000agent:main:escaped-"\\🦞';
function snapshot(): ChatSessionSnapshot {
  return {
    messages: [{ role: "assistant", content: "nested transcript" }],
    pagination: { hasMore: false },
    sessionId: "session-1",
  };
}

async function readMetadata() {
  const database = await openSessionSnapshotDatabase();
  if (!database) {
    throw new Error("expected snapshot database");
  }
  try {
    const transaction = database.transaction(CHAT_SNAPSHOT_METADATA_STORE_NAME, "readonly");
    const completed = transactionComplete(transaction);
    const value: unknown = await requestResult(
      transaction.objectStore(CHAT_SNAPSHOT_METADATA_STORE_NAME).get(sessionKey),
    );
    await completed;
    return value;
  } finally {
    database.close();
  }
}

describe("snapshot write serialization and scheduling", () => {
  let store: SessionSnapshotStore;
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    vi.stubGlobal("indexedDB", new IDBFactory());
    store = new SessionSnapshotStore();
    store.connect();
  });
  afterEach(async () => {
    store.clearMemory();
    store.disconnect();
    await store.whenIdle();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it.each([
    {
      name: "transcript display facts and progress",
      value: {
        ...snapshot(),
        transcriptMetadata: {
          key: "agent:main:notes",
          kind: "direct",
          status: "done",
          lastRunId: "run-1",
          runtimeMs: 65000,
          participants: [{ identity: { type: "profile", id: "reader" }, label: "Reader" }],
        },
        progressCard: {
          sessionKey: "agent:main:notes",
          revision: 3,
          updatedAt: 100,
          markdown: "Reviewing results",
        },
      },
    },
    {
      name: "nested non-JSON values",
      value: {
        ...snapshot(),
        deltaCursor: 'cursor-"\\🦞',
        displayedLeafEntryId: null,
        messages: [
          {
            content: [{ type: "text", text: "line\n🦞", omitted: undefined }],
            callback: () => true,
            symbol: Symbol("omitted"),
            date: new Date(0),
            nested: { values: [undefined, Number.NaN, Infinity, -0, () => true, Symbol("null")] },
          },
          undefined,
          null,
        ],
        pagination: { hasMore: true, nextOffset: 2.5, totalMessages: 10 },
      },
    },
    {
      name: "empty complete snapshot",
      value: {
        messages: [],
        pagination: { hasMore: false, completeSnapshot: true, totalMessages: 0 },
        sessionId: null,
      },
    },
    {
      name: "undefined optional fields",
      value: {
        ...snapshot(),
        deltaCursor: undefined,
        displayedLeafEntryId: undefined,
        pagination: { hasMore: false, totalMessages: undefined },
      },
    },
    {
      name: "custom JSON content",
      value: {
        ...snapshot(),
        messages: [{ toJSON: () => ({ text: "converted", nested: [1, null] }) }],
      },
    },
  ] satisfies Array<{ name: string; value: ChatSessionSnapshot }>)(
    "preserves the stored record and previous metadata weight for $name",
    async ({ value }) => {
      // eslint-disable-next-line unicorn/prefer-structured-clone -- JSON omission/conversion is the persisted storage contract.
      const sanitized: ChatSessionSnapshot = JSON.parse(JSON.stringify(value));
      const envelope = {
        projectionVersion: 2,
        savedAt: Date.now(),
        sessionId: value.sessionId,
        sessionKey,
      };
      // Previous persistence measured each sanitized array item, then both envelopes.
      const messageWeight = sanitized.messages.reduce<number>(
        (sum, message) => sum + JSON.stringify([message]).length - 2,
        0,
      );
      const expectedWeight =
        messageWeight +
        Math.max(0, sanitized.messages.length - 1) +
        JSON.stringify({ ...sanitized, messages: [] }).length +
        JSON.stringify(envelope).length;
      store.write(sessionKey, value);
      const stringify = vi.spyOn(JSON, "stringify");
      await store.flush();
      // One transcript serialization plus its small record envelope; no per-message remeasurement.
      expect(
        stringify.mock.calls.filter(([input]) => input !== null && typeof input === "object"),
      ).toHaveLength(2);
      expect(stringify.mock.calls[0]?.[0]).toBe(value);
      stringify.mockRestore();
      expect(await readStoredChatSnapshotRecord(sessionKey)).toEqual({
        ...envelope,
        snapshot: sanitized,
      });
      expect(await readMetadata()).toEqual({
        savedAt: envelope.savedAt,
        sessionKey,
        weight: expectedWeight,
      });
    },
  );

  it.each([
    { name: "non-array messages", patch: { snapshot: { ...snapshot(), messages: {} } } },
    {
      name: "missing messages",
      patch: { snapshot: { pagination: { hasMore: false }, sessionId: "session-1" } },
    },
    { name: "extra snapshot key", patch: { snapshot: { ...snapshot(), extra: true } } },
    { name: "extra record key", patch: { extra: true } },
    { name: "mismatched session IDs", patch: { sessionId: "other" } },
    { name: "invalid session ID", patch: { sessionId: 42 } },
    { name: "negative timestamp", patch: { savedAt: -1 } },
    { name: "infinite timestamp", patch: { savedAt: Infinity } },
    {
      name: "missing next offset",
      patch: { snapshot: { ...snapshot(), pagination: { hasMore: true } } },
    },
    {
      name: "negative next offset",
      patch: { snapshot: { ...snapshot(), pagination: { hasMore: true, nextOffset: -1 } } },
    },
    {
      name: "infinite total",
      patch: {
        snapshot: { ...snapshot(), pagination: { hasMore: false, totalMessages: Infinity } },
      },
    },
    {
      name: "extra pagination key",
      patch: { snapshot: { ...snapshot(), pagination: { hasMore: false, nextOffset: 0 } } },
    },
    {
      name: "invalid complete flag",
      patch: {
        snapshot: { ...snapshot(), pagination: { hasMore: false, completeSnapshot: false } },
      },
    },
  ])("rejects stored records with $name", async ({ patch }) => {
    const database = await openSessionSnapshotDatabase();
    if (!database) {
      throw new Error("expected snapshot database");
    }
    try {
      const transaction = database.transaction(CHAT_SNAPSHOT_STORE_NAME, "readwrite");
      const completed = transactionComplete(transaction);
      transaction.objectStore(CHAT_SNAPSHOT_STORE_NAME).put({
        projectionVersion: 2,
        savedAt: 1,
        sessionId: "session-1",
        sessionKey,
        snapshot: snapshot(),
        ...patch,
      });
      await completed;
    } finally {
      database.close();
    }
    expect(await store.read(sessionKey)).toBeNull();
    expect(await readStoredChatSnapshotRecord(sessionKey)).toBeUndefined();
  });

  function idleScheduler() {
    const request = vi.fn((callback: IdleRequestCallback, options?: IdleRequestOptions) =>
      window.setTimeout(
        () => callback({ didTimeout: true, timeRemaining: () => 0 }),
        options?.timeout,
      ),
    );
    const cancel = vi.fn((id: number) => window.clearTimeout(id));
    vi.stubGlobal("requestIdleCallback", request);
    vi.stubGlobal("cancelIdleCallback", cancel);
    return { request, cancel };
  }

  it("waits for idle time after debounce but bounds the idle wait", async () => {
    const idle = idleScheduler();
    const value = snapshot();
    const stringify = vi.spyOn(JSON, "stringify");
    store.write(sessionKey, value);
    vi.advanceTimersByTime(500);
    expect(stringify).not.toHaveBeenCalled();
    expect(idle.request).toHaveBeenCalledOnce();
    expect(idle.request.mock.calls[0]?.[1]?.timeout).toBe(1000);
    vi.advanceTimersByTime(999);
    expect(stringify).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(stringify.mock.calls[0]?.[0]).toBe(value);
    await store.whenIdle();
    expect(await store.read(sessionKey)).toEqual(value);
  });

  it("uses idle time before the timeout and cancels stale work on reschedule", async () => {
    const idle = idleScheduler();
    store.write(sessionKey, snapshot());
    vi.advanceTimersByTime(500);
    const latest = { ...snapshot(), messages: ["latest"] };
    store.write(sessionKey, latest);
    expect(idle.cancel).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(500);
    idle.request.mock.calls[1]?.[0]({ didTimeout: false, timeRemaining: () => 50 });
    await store.whenIdle();
    expect(await store.read(sessionKey)).toEqual(latest);
  });

  it("uses the debounce timer when idle callbacks are unavailable", async () => {
    vi.stubGlobal("requestIdleCallback", undefined);
    store.write(sessionKey, snapshot());
    vi.advanceTimersByTime(500);
    await store.whenIdle();
    expect(await store.read(sessionKey)).toEqual(snapshot());
  });

  it.each(["pagehide", "visibilitychange", "disconnect"])(
    "%s starts flushing synchronously and cancels the pending idle callback",
    async (event) => {
      const idle = idleScheduler();
      const value = snapshot();
      store.write(sessionKey, value);
      vi.advanceTimersByTime(500);
      const stringify = vi.spyOn(JSON, "stringify");
      if (event === "visibilitychange") {
        vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
        document.dispatchEvent(new Event(event));
      } else if (event === "disconnect") {
        store.disconnect();
      } else {
        window.dispatchEvent(new Event(event));
      }
      expect(stringify.mock.calls[0]?.[0]).toBe(value);
      expect(idle.cancel).toHaveBeenCalledOnce();
      await store.whenIdle();
      expect(await store.read(sessionKey)).toEqual(value);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("cancels idle work when the cache is cleared", async () => {
    const idle = idleScheduler();
    store.write(sessionKey, snapshot());
    vi.advanceTimersByTime(500);
    store.clearMemory();
    expect(idle.cancel).toHaveBeenCalledOnce();
    vi.runAllTimers();
    await store.whenIdle();
    expect(await store.read(sessionKey)).toBeNull();
  });
});
