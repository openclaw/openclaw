import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { createStorageMock } from "../../test-helpers/storage.ts";
import type { ChatSessionSnapshot } from "./session-message-cache.ts";
import * as database from "./session-snapshot-database.ts";
import { publishSnapshotInvalidation } from "./session-snapshot-invalidation-events.ts";
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
  it("reads raw records without validation and rejects malformed prewarm when consumed", async () => {
    await seed();
    const invalid = {
      projectionVersion: 2,
      savedAt: Date.now(),
      sessionKey: key,
      sessionId: stored.sessionId,
      snapshot: { ...stored, deltaCursor: 42 },
    };
    const db = await database.openSessionSnapshotDatabase();
    if (!db) {
      throw new Error("Snapshot database unavailable");
    }
    try {
      await new Promise<void>((resolve, reject) => {
        const transaction = db.transaction(database.CHAT_SNAPSHOT_STORE_NAME, "readwrite");
        transaction.addEventListener("complete", () => resolve());
        transaction.addEventListener("error", () =>
          reject(transaction.error ?? new Error("Snapshot write failed")),
        );
        transaction.objectStore(database.CHAT_SNAPSHOT_STORE_NAME).put(invalid);
      });
    } finally {
      db.close();
    }
    expect(await database.readStoredChatSnapshotRecord(key)).toEqual(invalid);
    prewarmChatSnapshot(key);
    const reader = new snapshots.SessionSnapshotStore();
    expect(await reader.read(key)).toBeNull();
    expect(await reader.read(otherKey)).toBeNull();
  });

  it("retires a completed prewarm before a later forget", async () => {
    const writer = await seed();
    const read = database.readStoredChatSnapshotRecord;
    const settled = createDeferred();
    vi.spyOn(database, "readStoredChatSnapshotRecord").mockImplementationOnce(async (cacheKey) => {
      const snapshot = await read(cacheKey);
      settled.resolve();
      return snapshot;
    });
    const open = vi.spyOn(indexedDB, "open");
    prewarmChatSnapshot(key);
    await settled.promise;
    writer.forget(key);
    open.mockClear();
    expect(await writer.read(key)).toEqual(stored);
    expect(open).toHaveBeenCalledOnce();
  });

  it.each(["session"] as const)(
    "fences a consumed pending read on %s invalidation",
    async (scope) => {
      await seed();
      const read = database.readStoredChatSnapshotRecord;
      const readingRecord = createDeferred<unknown>();
      vi.spyOn(database, "readStoredChatSnapshotRecord").mockReturnValueOnce(readingRecord.promise);
      prewarmChatSnapshot(key);
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
