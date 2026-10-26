import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { createStorageMock } from "../../test-helpers/storage.ts";
import type { ChatSessionSnapshot } from "./session-message-cache.ts";
import * as database from "./session-snapshot-database.ts";
import {
  publishSnapshotInvalidation,
  subscribeSnapshotInvalidation,
} from "./session-snapshot-invalidation-events.ts";
import { clearStoredChatSnapshots } from "./session-snapshot-invalidation.runtime.ts";
import { prewarmChatSnapshot } from "./session-snapshot-prewarm.ts";
import * as snapshots from "./session-snapshot-store.ts";

const key = 'scope:["wss://cache.example","account-a"]\u0000agent:main:routed';
const otherKey = 'scope:["wss://cache.example","account-a"]\u0000agent:main:other';
const stored: ChatSessionSnapshot = {
  messages: [{ role: "assistant", content: "Stored conversation" }],
  sessionId: "session-1",
  pagination: { hasMore: false, completeSnapshot: true },
  deltaCursor: "stored-cursor",
};

async function seed() {
  const writer = new snapshots.SessionSnapshotStore();
  writer.write(key, stored);
  writer.write(otherKey, { ...stored, sessionId: "other-session" });
  await writer.flush();
  return writer;
}

async function prewarm() {
  const writer = await seed();
  const open = vi.spyOn(indexedDB, "open");
  void prewarmChatSnapshot(key);
  return { writer, open, reader: new snapshots.SessionSnapshotStore() };
}

beforeEach(() => {
  vi.stubGlobal("indexedDB", new IDBFactory());
  vi.stubGlobal("localStorage", createStorageMock());
});
afterEach(async () => {
  vi.restoreAllMocks();
  await clearStoredChatSnapshots();
  vi.unstubAllGlobals();
});

describe("routed transcript prewarm", () => {
  it("publishes scoped invalidation before database cleanup settles", async () => {
    const scopePrefix = key.slice(0, key.indexOf("\u0000") + 1);
    const listener = vi.fn();
    onTestFinished(subscribeSnapshotInvalidation(listener));
    const cleanup = clearStoredChatSnapshots(scopePrefix);
    expect(listener).toHaveBeenCalledWith({ scopePrefix });
    await cleanup;
  });

  it("starts before consumption and reuses the matching read only once", async () => {
    const { open, reader } = await prewarm();
    await vi.dynamicImportSettled();
    expect(open).toHaveBeenCalledOnce();
    expect(await reader.read(key)).toEqual(stored);
    expect(open).toHaveBeenCalledOnce();
    expect(await reader.read(key)).toEqual(stored);
    expect(open).toHaveBeenCalledTimes(2);
  });

  it("leaves the prewarm available when another session reads normally", async () => {
    const { open, reader } = await prewarm();
    expect(await reader.read(otherKey)).toEqual({ ...stored, sessionId: "other-session" });
    expect(await reader.read(key)).toEqual(stored);
    expect(open).toHaveBeenCalledTimes(2);
  });

  it.each(["session", "all", "clear"] as const)(
    "drops an in-flight prewarm on %s invalidation",
    async (scope) => {
      const { open, reader } = await prewarm();
      await vi.dynamicImportSettled();
      await (scope === "clear"
        ? clearStoredChatSnapshots()
        : publishSnapshotInvalidation(scope === "session" ? { sessionKey: key } : {}));
      expect(open).toHaveBeenCalledOnce();
      expect(await reader.read(key)).toEqual(scope === "clear" ? null : stored);
      expect(open).toHaveBeenCalledTimes(2);
    },
  );

  it("keeps the routed prewarm when another session is invalidated", async () => {
    const { open, reader } = await prewarm();
    await publishSnapshotInvalidation({ sessionKey: otherKey });
    expect(await reader.read(key)).toEqual(stored);
    expect(open).toHaveBeenCalledOnce();
  });

  it.each(["write", "forget"] as const)(
    "retires a completed prewarm before a later %s",
    async (change) => {
      const writer = await seed();
      const read = database.readStoredChatSnapshotRecord;
      const settled = createDeferred();
      vi.spyOn(database, "readStoredChatSnapshotRecord").mockImplementationOnce(
        async (cacheKey) => {
          const snapshot = await read(cacheKey);
          settled.resolve();
          return snapshot;
        },
      );
      const open = vi.spyOn(indexedDB, "open");
      void prewarmChatSnapshot(key);
      await settled.promise;
      const latest = { ...stored, deltaCursor: "latest-cursor" };
      if (change === "write") {
        writer.write(key, latest);
        await writer.flush();
      } else {
        writer.forget(key);
      }
      open.mockClear();
      expect(await writer.read(key)).toEqual(change === "write" ? latest : stored);
      expect(open).toHaveBeenCalledOnce();
    },
  );

  it.each(["session", "all"] as const)(
    "fences a consumed pending read on %s invalidation",
    async (scope) => {
      await seed();
      const read = database.readStoredChatSnapshotRecord;
      const readingRecord = createDeferred<unknown>();
      vi.spyOn(database, "readStoredChatSnapshotRecord").mockReturnValueOnce(readingRecord.promise);
      void prewarmChatSnapshot(key);
      const reader = new snapshots.SessionSnapshotStore();
      reader.connect();
      try {
        const reading = reader.read(key);
        await publishSnapshotInvalidation(scope === "session" ? { sessionKey: key } : {});
        readingRecord.resolve(await read(key));
        expect(await reading).toBeNull();
      } finally {
        reader.disconnect();
        await reader.whenIdle();
      }
    },
  );
});
