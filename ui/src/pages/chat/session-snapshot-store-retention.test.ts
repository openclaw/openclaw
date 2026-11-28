/* @vitest-environment jsdom */

import { assert, describe, expect, it, vi } from "vitest";
import { collectGarbageForTest } from "../../test-helpers/garbage-collection.ts";
import { MAX_CACHED_CHAT_SESSIONS } from "./session-cache.ts";
import type { ChatMessageCache } from "./session-message-cache.ts";
import {
  cacheSnapshot,
  key,
  persist,
  readSnapshot,
  sessionKey,
  snapshot,
  useSessionSnapshotStoreFixture,
} from "./session-snapshot-store.test-support.ts";

describe("persistent chat session snapshot retention", () => {
  const { makeStore } = useSessionSnapshotStoreFixture();

  it.each([
    { count: 60, message: "small" },
    { count: 3, message: "x".repeat(9 * 1024 * 1024) },
  ])("bounds pending ownership before flushing $count snapshots", async ({ count, message }) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      vi.setSystemTime(1);
      const memory: ChatMessageCache = new Map();
      const store = makeStore(memory, true);
      await persist(store, sessionKey, snapshot("durable"));
      vi.setSystemTime(2);
      const { evicted, collectionControl } = await (async () => {
        cacheSnapshot(memory, sessionKey, snapshot(message));
        return {
          evicted: new WeakRef(memory.get(sessionKey)!.snapshot),
          collectionControl: new WeakRef({ unowned: true }),
        };
      })();
      for (let index = 0; index < count; index += 1) {
        cacheSnapshot(memory, key(`agent:main:pending-${index}`), snapshot(message, `${index}`));
      }
      expect(memory.has(sessionKey)).toBe(false);
      // Dropping an unsaved update must preserve the older disk snapshot and its receipt.
      expect.soft(store.readSavedAt(sessionKey)).toBe(1);
      expect.soft(await readSnapshot()).toEqual(snapshot("durable"));
      await collectGarbageForTest();
      expect(collectionControl.deref()).toBeUndefined();
      expect(evicted.deref()).toBeUndefined();
      await store.flush();
      expect(await readSnapshot(key(`agent:main:pending-${count - 1}`))).toEqual(
        snapshot(message, `${count - 1}`),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("releases hydrated snapshots after the message cache evicts them", async () => {
    const memoryCache: ChatMessageCache = new Map();
    const store = makeStore(memoryCache);
    await persist(store, sessionKey, snapshot("persisted"));
    const { evicted, collectionControl } = await (async () => {
      const hydrated = await store.read(sessionKey);
      assert.isNotNull(hydrated);
      cacheSnapshot(memoryCache, sessionKey, hydrated);
      return {
        evicted: new WeakRef(hydrated),
        collectionControl: new WeakRef({ unowned: true }),
      };
    })();
    for (let index = 0; index < MAX_CACHED_CHAT_SESSIONS; index += 1) {
      cacheSnapshot(memoryCache, key(`agent:main:newer-${index}`), snapshot(index));
    }
    await store.flush();
    expect(memoryCache.has(sessionKey)).toBe(false);
    await collectGarbageForTest();
    expect(collectionControl.deref()).toBeUndefined();
    expect(evicted.deref()).toBeUndefined();
    expect(store.readSavedAt(key("agent:main:newer-0"))).not.toBeNull();
  });
});
