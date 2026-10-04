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

  it("serializes nested non-JSON content once and preserves the stored record and metadata weight", async () => {
    const value: ChatSessionSnapshot = {
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
    };
    // eslint-disable-next-line unicorn/prefer-structured-clone -- JSON omission/conversion is the persisted storage contract.
    const sanitized: ChatSessionSnapshot = JSON.parse(JSON.stringify(value));
    const envelope = {
      projectionVersion: 1,
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
  });

  it.each([
    { name: "non-array messages", patch: { snapshot: { ...snapshot(), messages: {} } } },
    { name: "mismatched session IDs", patch: { sessionId: "other" } },
  ])("rejects stored records with $name", async ({ patch }) => {
    const database = await openSessionSnapshotDatabase();
    if (!database) {
      throw new Error("expected snapshot database");
    }
    try {
      const transaction = database.transaction(CHAT_SNAPSHOT_STORE_NAME, "readwrite");
      const completed = transactionComplete(transaction);
      transaction.objectStore(CHAT_SNAPSHOT_STORE_NAME).put({
        projectionVersion: 1,
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

  it.each(["idle timeout", "rescheduled idle", "debounce fallback"] as const)(
    "persists the latest snapshot after %s",
    async (mode) => {
      const idle = mode === "debounce fallback" ? null : idleScheduler();
      if (!idle) {
        vi.stubGlobal("requestIdleCallback", undefined);
      }
      let value = snapshot();
      const stringify = vi.spyOn(JSON, "stringify");
      store.write(sessionKey, value);
      vi.advanceTimersByTime(500);
      if (idle) {
        expect(stringify).not.toHaveBeenCalled();
        expect(idle.request).toHaveBeenCalledOnce();
        expect(idle.request.mock.calls[0]?.[1]?.timeout).toBe(1000);
        if (mode === "rescheduled idle") {
          value = { ...snapshot(), messages: ["latest"] };
          store.write(sessionKey, value);
          expect(idle.cancel).toHaveBeenCalledOnce();
          vi.advanceTimersByTime(500);
          idle.request.mock.calls[1]?.[0]({ didTimeout: false, timeRemaining: () => 50 });
        } else {
          vi.advanceTimersByTime(999);
          expect(stringify).not.toHaveBeenCalled();
          vi.advanceTimersByTime(1);
        }
      }
      expect(stringify.mock.calls[0]?.[0]).toBe(value);
      await store.whenIdle();
      expect(await store.read(sessionKey)).toEqual(value);
    },
  );

  it.each(["pagehide", "visibilitychange", "disconnect", "clear"])(
    "%s cancels pending idle work and settles the snapshot",
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
      } else if (event === "clear") {
        store.clearMemory();
      } else {
        window.dispatchEvent(new Event(event));
      }
      expect(idle.cancel).toHaveBeenCalledOnce();
      if (event === "clear") {
        vi.runAllTimers();
        await store.whenIdle();
        expect(await store.read(sessionKey)).toBeNull();
      } else {
        expect(stringify.mock.calls[0]?.[0]).toBe(value);
        await store.whenIdle();
        expect(await store.read(sessionKey)).toEqual(value);
      }
      expect(vi.getTimerCount()).toBe(0);
    },
  );
});
