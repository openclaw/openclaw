/* @vitest-environment jsdom */

import { IDBFactory, IDBObjectStore } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  requestResult,
  transactionComplete as transactionDone,
} from "../../lib/chat/control-ui-database.runtime.ts";
import { collectGarbageForTest } from "../../test-helpers/garbage-collection.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import { MAX_CACHED_CHAT_SESSIONS } from "./session-cache.ts";
import {
  appendChatMessageToCache,
  cacheChatSessionSnapshot,
  observeChatCache,
  type ChatMessageCache,
  type ChatSessionSnapshot,
} from "./session-message-cache.ts";
import {
  CHAT_SNAPSHOT_DB_NAME,
  CHAT_SNAPSHOT_METADATA_STORE_NAME,
  CHAT_SNAPSHOT_STORE_NAME,
  readStoredChatSnapshotRecord,
} from "./session-snapshot-database.ts";
import {
  clearStoredChatSnapshots,
  deleteStoredChatSnapshot,
} from "./session-snapshot-invalidation.ts";
import { resolveChatSnapshotKey } from "./session-snapshot-key.ts";
import { prewarmChatSnapshot } from "./session-snapshot-prewarm.ts";
import { SessionSnapshotStore } from "./session-snapshot-store.ts";

const snapshotHost = {
  settings: { gatewayUrl: "wss://cache.example" },
  client: { recoveryScope: "account-a", recoveryScopeReady: true },
  assistantAgentId: "main",
  agentsList: null,
  hello: null,
};
const key = (sessionKey: string) => resolveChatSnapshotKey(snapshotHost, { sessionKey });
const rawKey = (cacheKey: string) => cacheKey.slice(cacheKey.indexOf("\u0000") + 1);
function snapshot(message: unknown, sessionId = "session-1"): ChatSessionSnapshot {
  return {
    displayedLeafEntryId: "leaf-1",
    messages: [message],
    pagination: { hasMore: true, nextOffset: 1, totalMessages: 2 },
    sessionId,
  };
}

async function putRawRecord(record: unknown, metadata?: unknown): Promise<void> {
  const request = indexedDB.open(CHAT_SNAPSHOT_DB_NAME);
  const database = await requestResult(request);
  const transaction = database.transaction(
    [CHAT_SNAPSHOT_STORE_NAME, CHAT_SNAPSHOT_METADATA_STORE_NAME],
    "readwrite",
  );
  const completed = transactionDone(transaction);
  transaction.objectStore(CHAT_SNAPSHOT_STORE_NAME).put(record);
  transaction.objectStore(CHAT_SNAPSHOT_METADATA_STORE_NAME).put(
    metadata ?? {
      savedAt: Date.now(),
      sessionKey: (record as { sessionKey: string }).sessionKey,
      weight: 0,
    },
  );
  await completed;
  database.close();
}

async function putVersionOneRecord(sessionKey: string): Promise<void> {
  const request = indexedDB.open(CHAT_SNAPSHOT_DB_NAME, 1);
  request.addEventListener("upgradeneeded", () => {
    request.result.createObjectStore(CHAT_SNAPSHOT_STORE_NAME, { keyPath: "sessionKey" });
  });
  const database = await requestResult(request);
  const transaction = database.transaction(CHAT_SNAPSHOT_STORE_NAME, "readwrite");
  const completed = transactionDone(transaction);
  transaction.objectStore(CHAT_SNAPSHOT_STORE_NAME).put({ sessionKey });
  await completed;
  database.close();
}

async function readRawRecord(
  sessionKey: string,
  storeName = CHAT_SNAPSHOT_STORE_NAME,
): Promise<{ savedAt: number; weight?: number } | undefined> {
  const request = indexedDB.open(CHAT_SNAPSHOT_DB_NAME);
  const database = await requestResult(request);
  const transaction = database.transaction(storeName, "readonly");
  const result = await requestResult<{ savedAt: number; weight?: number } | undefined>(
    transaction.objectStore(storeName).get(sessionKey),
  );
  await transactionDone(transaction);
  database.close();
  return result;
}

describe("persistent chat session snapshots", () => {
  beforeEach(() => {
    vi.stubGlobal("indexedDB", new IDBFactory());
    vi.stubGlobal("localStorage", createStorageMock());
  });

  afterEach(async () => {
    await clearStoredChatSnapshots();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("retires one Gateway cache without touching another Gateway or account", async () => {
    const memory: ChatMessageCache = new Map();
    const store = new SessionSnapshotStore(memory);
    store.connect();
    observeChatCache(memory, store);
    const target = { sessionKey: "agent:main:shared" };
    const other = { ...snapshotHost, settings: { gatewayUrl: "wss://other.example" } };
    const second = {
      ...snapshotHost,
      client: { recoveryScope: "account-b", recoveryScopeReady: true },
    };
    for (const host of [snapshotHost, other, second]) {
      cacheChatSessionSnapshot(memory, host, target, snapshot(host.settings.gatewayUrl));
    }
    await store.flush();
    const firstKey = resolveChatSnapshotKey(snapshotHost, target);
    await clearStoredChatSnapshots(firstKey.slice(0, firstKey.indexOf("\u0000") + 1));
    expect(memory.has(firstKey)).toBe(false);
    expect(await store.read(firstKey)).toBeNull();
    expect(await store.read(resolveChatSnapshotKey(other, target))).not.toBeNull();
    expect(await store.read(resolveChatSnapshotKey(second, target))).not.toBeNull();
    store.disconnect();
    await store.whenIdle();
  });

  it("keeps Incognito history in memory without persisting snapshots or metadata", async () => {
    const memory: ChatMessageCache = new Map();
    const writer = new SessionSnapshotStore(memory);
    observeChatCache(memory, writer);
    const privateKeys = ["dashboard", "subagent", "internal-session-effects"].map((kind) =>
      key(`agent:main:${kind}:incognito-private`),
    );
    const ordinaryKey = key("agent:main:dashboard:ordinary");
    cacheChatSessionSnapshot(
      memory,
      snapshotHost,
      { sessionKey: rawKey(ordinaryKey) },
      snapshot(ordinaryKey),
    );
    const ordinaryFlush = writer.flush();
    for (const sessionKey of privateKeys) {
      cacheChatSessionSnapshot(
        memory,
        snapshotHost,
        { sessionKey: rawKey(sessionKey) },
        snapshot(sessionKey),
      );
    }
    await Promise.all([ordinaryFlush, writer.flush()]);

    const reader = new SessionSnapshotStore();
    await reader.loadSavedAtIndex();
    for (const sessionKey of privateKeys) {
      expect(memory.get(sessionKey)?.snapshot).toEqual(snapshot(sessionKey));
      expect(await readRawRecord(sessionKey)).toBeUndefined();
      expect(await readRawRecord(sessionKey, CHAT_SNAPSHOT_METADATA_STORE_NAME)).toBeUndefined();
      expect(writer.readSavedAt(sessionKey)).toBeNull();
      expect(reader.readSavedAt(sessionKey)).toBeNull();
      expect(await reader.read(sessionKey)).toBeNull();
    }
    expect(await reader.read(ordinaryKey)).toEqual(snapshot(ordinaryKey));
    expect(reader.readSavedAt(ordinaryKey)).not.toBeNull();
  });

  it("refuses Incognito records through direct reads and routed prewarm", async () => {
    const privateKey = key("agent:main:dashboard:incognito-existing");
    const writer = new SessionSnapshotStore();
    writer.write(key("agent:main:ordinary"), snapshot("ordinary"));
    await writer.flush();
    // A foreign/older writer must not make private records readable by this UI.
    await putRawRecord({
      projectionVersion: 1,
      sessionKey: privateKey,
      savedAt: 1,
      sessionId: "session-1",
      snapshot: snapshot("private"),
    });

    expect(await readStoredChatSnapshotRecord(privateKey)).toBeUndefined();
    prewarmChatSnapshot(privateKey);
    expect(await new SessionSnapshotStore().read(privateKey)).toBeNull();
  });

  it("purges all legacy unscoped history rather than adopting an unknown account", async () => {
    const privateKey = "agent:main:dashboard:incognito-old";
    const orphanedKey = "agent:main:subagent:incognito-metadata-only";
    const ordinaryKey = "agent:main:dashboard:retained";
    const request = indexedDB.open(CHAT_SNAPSHOT_DB_NAME, 2);
    request.addEventListener("upgradeneeded", () => {
      request.result.createObjectStore(CHAT_SNAPSHOT_STORE_NAME, { keyPath: "sessionKey" });
      request.result.createObjectStore(CHAT_SNAPSHOT_METADATA_STORE_NAME, {
        keyPath: "sessionKey",
      });
    });
    const database = await requestResult(request);
    database.close();
    for (const sessionKey of [privateKey, ordinaryKey]) {
      await putRawRecord({
        sessionKey,
        savedAt: 1,
        sessionId: "session-1",
        snapshot: snapshot(sessionKey),
      });
    }
    await putRawRecord(
      {
        sessionKey: ordinaryKey,
        savedAt: 1,
        sessionId: "session-1",
        snapshot: snapshot(ordinaryKey),
      },
      { sessionKey: orphanedKey, savedAt: 1, weight: 0 },
    );

    // A direct routed prewarm must not expose previously persisted private history.
    prewarmChatSnapshot(privateKey);
    const reader = new SessionSnapshotStore();
    expect(await reader.read(privateKey)).toBeNull();
    await reader.loadSavedAtIndex();
    expect(await readStoredChatSnapshotRecord(privateKey)).toBeUndefined();
    expect(await readRawRecord(privateKey)).toBeUndefined();
    expect(await readRawRecord(privateKey, CHAT_SNAPSHOT_METADATA_STORE_NAME)).toBeUndefined();
    expect(await readRawRecord(orphanedKey, CHAT_SNAPSHOT_METADATA_STORE_NAME)).toBeUndefined();
    expect(reader.readSavedAt(privateKey)).toBeNull();
    expect(reader.readSavedAt(orphanedKey)).toBeNull();
    expect(await reader.read(ordinaryKey)).toBeNull();
    expect(reader.readSavedAt(ordinaryKey)).toBeNull();
  });

  it("does not let an append miss replace a richer persisted snapshot", async () => {
    const sessionKey = key("agent:main:append-miss");
    const persisted = {
      ...snapshot("unused", "session-rich"),
      deltaCursor: "cursor-rich",
      messages: ["one", "two", "three", "four", "five"],
    };
    const writer = new SessionSnapshotStore();
    writer.write(sessionKey, persisted);
    await writer.flush();

    const memoryCache: ChatMessageCache = new Map();
    const store = new SessionSnapshotStore(memoryCache);
    store.connect();
    observeChatCache(memoryCache, store);
    try {
      appendChatMessageToCache(
        memoryCache,
        snapshotHost,
        { sessionKey: rawKey(sessionKey) },
        "newest",
      );
      await store.flush();

      expect(await new SessionSnapshotStore().read(sessionKey)).toEqual(persisted);
    } finally {
      store.disconnect();
      await store.whenIdle();
    }
  });

  it("defers snapshot sanitization until flush", async () => {
    const sessionKey = key("agent:main:deferred-sanitize");
    const writer = new SessionSnapshotStore();
    writer.write(sessionKey, snapshot("persisted"));
    await writer.flush();

    writer.write(sessionKey, snapshot(1n));

    await writer.flush();
    expect(await new SessionSnapshotStore().read(sessionKey)).toBeNull();
  });

  it("suppresses unchanged writes only for the latest hydration", async () => {
    let now = 1;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const sessionKey = key("agent:main:hydrate-only");
    const writer = new SessionSnapshotStore();
    writer.write(sessionKey, snapshot("persisted"));
    await writer.flush();
    expect((await readRawRecord(sessionKey))?.savedAt).toBe(1);

    now = 2;
    const memoryCache: ChatMessageCache = new Map();
    const reader = new SessionSnapshotStore(memoryCache);
    observeChatCache(memoryCache, reader);
    const previousHydration = await reader.read(sessionKey);
    const hydrated = await reader.read(sessionKey);
    if (!previousHydration || !hydrated) {
      throw new Error("expected hydrated snapshot");
    }
    cacheChatSessionSnapshot(
      memoryCache,
      snapshotHost,
      { sessionKey: rawKey(sessionKey) },
      hydrated,
    );
    await reader.flush();

    expect((await readRawRecord(sessionKey))?.savedAt).toBe(1);
    reader.write(sessionKey, previousHydration);
    await reader.flush();
    expect((await readRawRecord(sessionKey))?.savedAt).toBe(2);
  });

  it("releases hydrated snapshots after the message cache evicts them", async () => {
    const sessionKey = key("agent:main:evicted-hydration");
    const memoryCache: ChatMessageCache = new Map();
    const store = new SessionSnapshotStore(memoryCache);
    observeChatCache(memoryCache, store);
    store.write(sessionKey, snapshot("persisted"));
    await store.flush();

    const { evicted, collectionControl } = await (async () => {
      const hydrated = await store.read(sessionKey);
      if (!hydrated) {
        throw new Error("expected hydrated snapshot");
      }
      cacheChatSessionSnapshot(
        memoryCache,
        snapshotHost,
        { sessionKey: rawKey(sessionKey) },
        hydrated,
      );
      return {
        evicted: new WeakRef(hydrated),
        collectionControl: new WeakRef({ unowned: true }),
      };
    })();
    for (let index = 0; index < MAX_CACHED_CHAT_SESSIONS; index += 1) {
      cacheChatSessionSnapshot(
        memoryCache,
        snapshotHost,
        { sessionKey: `agent:main:newer-${index}` },
        snapshot(index),
      );
    }
    await store.flush();
    expect(memoryCache.has(sessionKey)).toBe(false);
    await collectGarbageForTest();
    expect(collectionControl.deref()).toBeUndefined();
    expect(evicted.deref()).toBeUndefined();
    expect(store.readSavedAt(key("agent:main:newer-0"))).not.toBeNull();
  });

  it("evicts the oldest sessions by count and total serialized weight", async () => {
    let now = 0;
    vi.spyOn(Date, "now").mockImplementation(() => ++now);
    const writer = new SessionSnapshotStore();
    for (let index = 0; index <= 20; index += 1) {
      writer.write(key(`agent:main:count-${index}`), snapshot(index, `count-${index}`));
      await writer.flush();
    }
    const reader = new SessionSnapshotStore();
    expect(writer.readSavedAt(key("agent:main:count-0"))).toBeNull();
    expect(await reader.read(key("agent:main:count-0"))).toBeNull();
    expect(await reader.read(key("agent:main:count-20"))).not.toBeNull();

    await clearStoredChatSnapshots();
    const large = "x".repeat(9 * 1024 * 1024);
    for (let index = 0; index < 3; index += 1) {
      writer.write(key(`agent:main:weight-${index}`), snapshot(large, `weight-${index}`));
      await writer.flush();
    }
    const weightReader = new SessionSnapshotStore();
    expect(await weightReader.read(key("agent:main:weight-0"))).toBeNull();
    expect(await weightReader.read(key("agent:main:weight-2"))).not.toBeNull();
  });

  it.each(["snapshot", "metadata"] as const)(
    "resets corrupt %s without hydrating unrelated transcripts",
    async (corruption) => {
      const valid = key("agent:main:valid");
      const corrupt = key("agent:main:corrupt");
      const writer = new SessionSnapshotStore();
      writer.write(valid, snapshot("valid"));
      await writer.flush();
      await putRawRecord(
        {
          projectionVersion: 1,
          sessionKey: corrupt,
          sessionId: "session-1",
          savedAt: Date.now(),
          snapshot:
            corruption === "snapshot" ? { messages: "not-an-array" } : snapshot("corrupt metadata"),
        },
        corruption === "metadata"
          ? { sessionKey: corrupt, savedAt: "invalid", weight: 0 }
          : undefined,
      );
      const reader = new SessionSnapshotStore();
      await reader.loadSavedAtIndex();
      if (corruption === "snapshot") {
        expect(reader.readSavedAt(valid)).not.toBeNull();
        expect(reader.readSavedAt(corrupt)).not.toBeNull();
        expect(await reader.read(corrupt)).toBeNull();
      } else {
        expect(reader.readSavedAt(corrupt)).toBeNull();
      }
      expect(await reader.read(valid)).toBeNull();
    },
  );

  it.each(["unrelated", "session", "cache-eviction", "all"] as const)(
    "settles an in-flight transcript through %s invalidation",
    async (scope) => {
      const sessionKey = key("agent:main:in-flight");
      const value = snapshot("important transcript");
      const writer = new SessionSnapshotStore();
      writer.connect();
      try {
        writer.write(sessionKey, value);
        await Promise.all([
          writer.flush(),
          scope === "all"
            ? clearStoredChatSnapshots()
            : writer.delete(
                scope === "unrelated" ? key("agent:main:other") : sessionKey,
                scope === "cache-eviction" ? scope : undefined,
              ),
        ]);
        expect(await new SessionSnapshotStore().read(sessionKey)).toEqual(
          scope === "unrelated" ? value : null,
        );
        if (scope === "unrelated") {
          expect(writer.readSavedAt(sessionKey)).not.toBeNull();
        } else {
          expect(writer.readSavedAt(sessionKey)).toBeNull();
        }
      } finally {
        writer.disconnect();
        await writer.whenIdle();
      }
    },
  );

  it.each(["account", "session", "cache-eviction"] as const)(
    "does not restore retired %s metadata during the initial seed",
    async (scope) => {
      const retired = key("agent:main:retired-seed");
      const retained = resolveChatSnapshotKey(
        { ...snapshotHost, client: { recoveryScope: "other-account", recoveryScopeReady: true } },
        { sessionKey: "agent:main:retained-seed" },
      );
      const writer = new SessionSnapshotStore();
      writer.write(retired, snapshot("retired"));
      writer.write(retained, snapshot("retained"));
      await writer.flush();
      const reader = new SessionSnapshotStore();
      reader.connect();
      try {
        let deletion: Promise<void> | undefined;
        const originalGetAll = Reflect.get(
          IDBObjectStore.prototype,
          "getAll",
        ) as IDBObjectStore["getAll"];
        vi.spyOn(IDBObjectStore.prototype, "getAll").mockImplementationOnce(function (
          this: IDBObjectStore,
          ...args
        ) {
          const request = originalGetAll.apply(this, args);
          request.addEventListener("success", () => {
            deletion =
              scope === "account"
                ? clearStoredChatSnapshots(retired.slice(0, retired.indexOf("\u0000") + 1))
                : writer.delete(retired, scope === "cache-eviction" ? scope : undefined);
          });
          return request;
        });
        await reader.loadSavedAtIndex();
        expect(deletion).toBeDefined();
        await deletion;
        expect(reader.readSavedAt(retired)).toBeNull();
        expect(reader.readSavedAt(retained)).not.toBeNull();
        await reader.loadSavedAtIndex();
        expect(reader.readSavedAt(retained)).not.toBeNull();
      } finally {
        reader.disconnect();
        await reader.whenIdle();
      }
    },
  );

  it("upgrades a version one database before deleting an invalidated snapshot", async () => {
    const sessionKey = key("agent:main:legacy-delete");
    await putVersionOneRecord(sessionKey);

    await new SessionSnapshotStore().delete(sessionKey);

    const request = indexedDB.open(CHAT_SNAPSHOT_DB_NAME);
    const database = await requestResult(request);
    expect(database.version).toBe(4);
    expect(Array.from(database.objectStoreNames)).toEqual([
      CHAT_SNAPSHOT_METADATA_STORE_NAME,
      CHAT_SNAPSHOT_STORE_NAME,
    ]);
    const transaction = database.transaction(
      [CHAT_SNAPSHOT_STORE_NAME, CHAT_SNAPSHOT_METADATA_STORE_NAME],
      "readonly",
    );
    const snapshotRequest = transaction.objectStore(CHAT_SNAPSHOT_STORE_NAME).get(sessionKey);
    const metadataRequest = transaction
      .objectStore(CHAT_SNAPSHOT_METADATA_STORE_NAME)
      .get(sessionKey);
    const completed = transactionDone(transaction);
    await Promise.all([requestResult(snapshotRequest), requestResult(metadataRequest), completed]);
    expect(snapshotRequest.result).toBeUndefined();
    expect(metadataRequest.result).toBeUndefined();
    database.close();
  });

  it.each(["all", "session"] as const)(
    "broadcasts %s invalidation without clearing unrelated peer memory",
    async (scope) => {
      const deleted = key("agent:main:deleted-in-peer");
      const retained = key("agent:main:retained-in-peer");
      const memory: ChatMessageCache = new Map();
      const store = new SessionSnapshotStore(memory);
      store.connect();
      observeChatCache(memory, store);
      const cacheSnapshot = (sessionKey: string) =>
        cacheChatSessionSnapshot(
          memory,
          snapshotHost,
          { sessionKey: rawKey(sessionKey) },
          snapshot(sessionKey),
        );
      cacheSnapshot(deleted);
      cacheSnapshot(retained);
      await store.flush();
      const setItem = vi.spyOn(localStorage, "setItem");
      try {
        await (scope === "all" ? clearStoredChatSnapshots() : deleteStoredChatSnapshot(deleted));
        const broadcast = setItem.mock.calls.findLast(
          ([storageKey]) => storageKey === "openclaw.control.chatSnapshots.invalidate.v1",
        )?.[1];
        expect(broadcast).toBeDefined();
        if (scope === "all") {
          expect(broadcast).toBe("{}");
        }
        for (const peerValue of scope === "all" ? [broadcast, "1"] : [broadcast]) {
          cacheSnapshot(deleted);
          await store.flush();
          window.dispatchEvent(
            new StorageEvent("storage", {
              key: "openclaw.control.chatSnapshots.invalidate.v1",
              newValue: peerValue,
            }),
          );
          expect(store.readSavedAt(deleted)).toBeNull();
          expect(memory.has(deleted)).toBe(false);
          if (scope === "all") {
            expect(memory.size).toBe(0);
          } else {
            expect(store.readSavedAt(retained)).not.toBeNull();
            expect(memory.has(retained)).toBe(true);
          }
        }
      } finally {
        store.disconnect();
        await store.whenIdle();
      }
    },
  );

  it("keeps every operation non-fatal when IndexedDB is unavailable or throws", async () => {
    vi.stubGlobal("indexedDB", undefined);
    const unavailable = new SessionSnapshotStore();
    unavailable.write(key("agent:main:none"), snapshot("none"));
    await expect(unavailable.flush()).resolves.toBeUndefined();
    await expect(unavailable.read(key("agent:main:none"))).resolves.toBeNull();
    await expect(unavailable.delete(key("agent:main:none"))).resolves.toBeUndefined();

    vi.stubGlobal("indexedDB", {
      open: () => {
        throw new DOMException("denied", "SecurityError");
      },
      deleteDatabase: () => {
        throw new DOMException("denied", "SecurityError");
      },
    });
    const denied = new SessionSnapshotStore();
    denied.write(key("agent:main:denied"), snapshot("denied"));
    await expect(denied.flush()).resolves.toBeUndefined();
    await expect(denied.read(key("agent:main:denied"))).resolves.toBeNull();
    await expect(clearStoredChatSnapshots()).resolves.toBeUndefined();
  });
});
