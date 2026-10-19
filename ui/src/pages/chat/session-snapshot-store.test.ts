/* @vitest-environment jsdom */

import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseSidebarSnapshot } from "../../components/sidebar-snapshot-data.ts";
import { sidebarSnapshot } from "../../components/sidebar-snapshot.test-support.ts";
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
} from "./session-message-cache.ts";
import {
  CHAT_SNAPSHOT_DB_NAME as DB,
  CHAT_SNAPSHOT_METADATA_STORE_NAME as METADATA,
  CHAT_SNAPSHOT_STORE_NAME as SNAPSHOTS,
  SIDEBAR_SNAPSHOT_STORE_NAME as SIDEBAR,
  readStoredChatSnapshotRecord,
} from "./session-snapshot-database.ts";
import {
  clearStoredChatSnapshots,
  deleteStoredChatSnapshot,
} from "./session-snapshot-invalidation.ts";
import { resolveChatSnapshotKey } from "./session-snapshot-key.ts";
import { prewarmChatSnapshot } from "./session-snapshot-prewarm.ts";
import { SessionSnapshotStore } from "./session-snapshot-store.ts";
import type { ChatSessionSnapshot } from "./session-snapshot-types.ts";

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

function cacheSnapshot(memory: ChatMessageCache, sessionKey: string, value = snapshot(sessionKey)) {
  cacheChatSessionSnapshot(memory, snapshotHost, { sessionKey: rawKey(sessionKey) }, value);
}
async function persist(
  store: SessionSnapshotStore,
  sessionKey: string,
  value: ChatSessionSnapshot,
) {
  store.write(sessionKey, value);
  await store.flush();
}
const envelope = (sessionKey: string, value: ChatSessionSnapshot, projectionVersion = 3) => ({
  projectionVersion,
  sessionKey,
  savedAt: 1,
  sessionId: "session-1",
  snapshot: value,
});

async function openDatabase(version?: number, stores: string[] = []) {
  const request = indexedDB.open(DB, version);
  request.addEventListener("upgradeneeded", () => {
    for (const name of stores) {
      request.result.createObjectStore(name, { keyPath: "sessionKey" });
    }
  });
  return requestResult(request);
}

async function putRawRecord(record: unknown, metadata?: unknown): Promise<void> {
  const database = await openDatabase();
  const transaction = database.transaction([SNAPSHOTS, METADATA], "readwrite");
  const completed = transactionDone(transaction);
  transaction.objectStore(SNAPSHOTS).put(record);
  transaction.objectStore(METADATA).put(
    metadata ?? {
      savedAt: Date.now(),
      sessionKey: (record as { sessionKey: string }).sessionKey,
      weight: 0,
    },
  );
  await completed;
  database.close();
}

async function readRawRecord(
  sessionKey: string,
  storeName = SNAPSHOTS,
): Promise<{ savedAt: number; weight?: number } | undefined> {
  const database = await openDatabase();
  const transaction = database.transaction(storeName, "readonly");
  const result = await requestResult<{ savedAt: number; weight?: number } | undefined>(
    transaction.objectStore(storeName).get(sessionKey),
  );
  await transactionDone(transaction);
  database.close();
  return result;
}

describe("persistent chat session snapshots", () => {
  let writer: SessionSnapshotStore;
  const connected = new Set<SessionSnapshotStore>();
  function makeStore(memory?: ChatMessageCache, connect = false) {
    const store = new SessionSnapshotStore(memory);
    if (memory) {
      observeChatCache(memory, store);
    }
    if (connect) {
      store.connect();
      connected.add(store);
    }
    return store;
  }
  beforeEach(() => {
    vi.stubGlobal("indexedDB", new IDBFactory());
    vi.stubGlobal("localStorage", createStorageMock());
    writer = makeStore();
  });

  afterEach(async () => {
    for (const store of connected) {
      store.disconnect();
      await store.whenIdle();
    }
    connected.clear();
    await clearStoredChatSnapshots();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it.each([false, true])(
    "persists raw metadata with its receipts unless privacy projection changes it (pairing: %s)",
    async (pairing) => {
      const sessionKey = key("agent:main:metadata");
      const value: ChatSessionSnapshot = {
        ...snapshot("history"),
        deltaCursor: "cursor-1",
        historyState: {
          stateRevision: {
            pendingInputs: "inputs-1",
            sessionInfo: "info-1",
            commands: "commands-1",
          },
          commands: [
            {
              name: "skill",
              description: "Run skill",
              source: "skill",
              scope: "text",
              acceptsArgs: true,
            },
          ],
          pendingInputs: {
            items: [
              {
                id: "input-1",
                acceptedAt: 1,
                state: "queued",
                queued: true,
                message: {
                  role: "user",
                  content: pairing
                    ? [{ type: "openclaw_pairing_qr", data: "synthetic-private-pairing" }]
                    : "Follow up.",
                },
              },
            ],
            total: 1,
            queuedCount: 1,
          },
          sessionInfo: {
            key: "agent:main:metadata",
            kind: "direct",
            sessionId: "session-1",
            updatedAt: 1,
          },
        },
      };
      const store = new SessionSnapshotStore();
      store.write(sessionKey, value);
      await store.flush();
      const restored = await new SessionSnapshotStore().read(sessionKey);
      expect(restored?.deltaCursor).toBe("cursor-1");
      expect(restored?.historyState).toEqual(pairing ? undefined : value.historyState);
      expect(JSON.stringify(await readStoredChatSnapshotRecord(sessionKey))).not.toContain(
        "synthetic-private-pairing",
      );
    },
  );

  it("restores persisted startup state from before command receipts were added", async () => {
    const sessionKey = key("agent:main:existing-snapshot");
    await persist(writer, sessionKey, snapshot("initialize database"));
    const previous: ChatSessionSnapshot = {
      ...snapshot("Existing conversation"),
      deltaCursor: "existing-cursor",
      historyState: {
        stateRevision: { pendingInputs: "inputs-1", sessionInfo: "info-1" },
        pendingInputs: { items: [], total: 0 },
        sessionInfo: {
          key: "agent:main:existing-snapshot",
          kind: "direct",
          sessionId: "session-1",
          updatedAt: 1,
        },
      },
    };
    await putRawRecord(envelope(sessionKey, previous));
    expect(await new SessionSnapshotStore().read(sessionKey)).toEqual(previous);
  });

  it("restores bounded sidebar facts with legacy defaults and strips live-only fields", async () => {
    const store = makeStore(undefined, true);
    const sidebarKey = `${key("").split("\u0000")[0]}\u0000sidebar:operator`;
    const row = { key: "agent:main:cedar", kind: "direct", label: "Cedar" };
    const roster = {
      agentId: "main",
      result: {
        ts: 1,
        path: "sessions",
        count: 1,
        defaults: { model: null, modelProvider: null, contextTokens: null },
        sessions: [{ ...row, hasActiveRun: true }],
      },
      groups: [],
      groupSettings: [],
      sectionOrder: [],
    };
    async function putSidebarModel(model: unknown): Promise<void> {
      const database = await openDatabase();
      const transaction = database.transaction(SIDEBAR, "readwrite");
      const completed = transactionDone(transaction);
      transaction.objectStore(SIDEBAR).put({
        sessionKey: sidebarKey,
        projectionVersion: 1,
        savedAt: Date.now(),
        model,
      });
      await completed;
      database.close();
    }
    expect(await store.writeSidebar(sidebarKey, sidebarSnapshot, parseSidebarSnapshot)).toBe(true);
    // Older or foreign writers can leave data that is not an admitted live model.
    await putSidebarModel({
      ...sidebarSnapshot,
      peoplePresenceFilter: undefined,
      offlineUsers: undefined,
      roster,
      footer: { id: "operator", scopes: ["operator.admin"] },
      token: "synthetic-disallowed-field",
    });
    const restored = await store.readSidebar(sidebarKey, parseSidebarSnapshot);
    expect(restored).toMatchObject({ peoplePresenceFilter: "online", offlineUsers: [] });
    expect(restored?.roster?.result.sessions).toEqual([row]);
    expect(restored?.footer).toEqual({ id: "operator" });
    expect(restored).not.toHaveProperty("token");
    await putSidebarModel({
      ...sidebarSnapshot,
      roster: {
        ...roster,
        result: { ...roster.result, sessions: [{ ...row, incognito: true }] },
      },
    });
    expect(await store.readSidebar(sidebarKey, parseSidebarSnapshot)).toBeNull();
  });

  it.each([
    { snapshot: { ...snapshot("message"), unexpected: true } },
    { snapshot: { ...snapshot("message"), pagination: { hasMore: false, nextOffset: 1 } } },
    { snapshot: { ...snapshot("message"), pagination: { hasMore: true, nextOffset: -1 } } },
    {
      snapshot: {
        ...snapshot("message"),
        historyState: {
          stateRevision: { sessionInfo: "info-1" },
          sessionInfo: { key: "s", kind: "direct", owner: { actor: { type: "unknown" } } },
        },
      },
    },
    { sessionId: "different-session" },
  ])(
    "rejects malformed durable snapshot envelopes without exposing cached history ($snapshot)",
    async (corrupt) => {
      const sessionKey = key("agent:main:corrupt-envelope");
      await persist(writer, sessionKey, snapshot("message"));
      const persisted = await readStoredChatSnapshotRecord(sessionKey);
      if (!persisted || typeof persisted !== "object") {
        throw new Error("expected the writer to persist a snapshot envelope");
      }
      await putRawRecord({ ...persisted, ...corrupt });
      expect(await new SessionSnapshotStore().read(sessionKey)).toBeNull();
      expect(await readStoredChatSnapshotRecord(sessionKey)).toBeUndefined();
    },
  );

  it("retires one Gateway cache without touching another Gateway or account", async () => {
    const memory: ChatMessageCache = new Map();
    const store = makeStore(memory, true);
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
  });

  it("keeps Incognito history in memory without persisting snapshots or metadata", async () => {
    const memory: ChatMessageCache = new Map();
    writer = makeStore(memory);
    const privateKeys = ["dashboard", "subagent", "internal-session-effects"].map((kind) =>
      key(`agent:main:${kind}:incognito-private`),
    );
    const ordinaryKey = key("agent:main:dashboard:ordinary");
    cacheSnapshot(memory, ordinaryKey);
    const ordinaryFlush = writer.flush();
    for (const sessionKey of privateKeys) {
      cacheSnapshot(memory, sessionKey);
    }
    await Promise.all([ordinaryFlush, writer.flush()]);
    const reader = new SessionSnapshotStore();
    await reader.loadSavedAtIndex();
    for (const sessionKey of privateKeys) {
      expect(memory.get(sessionKey)?.snapshot).toEqual(snapshot(sessionKey));
      expect(await readRawRecord(sessionKey)).toBeUndefined();
      expect(await readRawRecord(sessionKey, METADATA)).toBeUndefined();
      expect(writer.readSavedAt(sessionKey)).toBeNull();
      expect(reader.readSavedAt(sessionKey)).toBeNull();
      expect(await reader.read(sessionKey)).toBeNull();
    }
    expect(await reader.read(ordinaryKey)).toEqual(snapshot(ordinaryKey));
    expect(reader.readSavedAt(ordinaryKey)).not.toBeNull();
  });

  it("refuses Incognito records through direct reads and routed prewarm", async () => {
    const privateKey = key("agent:main:dashboard:incognito-existing");
    await persist(writer, key("agent:main:ordinary"), snapshot("ordinary"));
    // A foreign/older writer must not make private records readable by this UI.
    await putRawRecord(envelope(privateKey, snapshot("private")));
    expect(await readStoredChatSnapshotRecord(privateKey)).toBeUndefined();
    prewarmChatSnapshot(privateKey);
    expect(await new SessionSnapshotStore().read(privateKey)).toBeNull();
  });

  it.each(["direct", "prewarmed"])(
    "discards a superseded unbounded projection (%s)",
    async (mode) => {
      const sessionKey = key("agent:main:old-projection");
      await persist(writer, sessionKey, snapshot("current"));
      await putRawRecord(envelope(sessionKey, snapshot("old"), 2));
      if (mode === "prewarmed") {
        prewarmChatSnapshot(sessionKey);
      }
      expect(await new SessionSnapshotStore().read(sessionKey)).toBeNull();
    },
  );

  it("purges all legacy unscoped history rather than adopting an unknown account", async () => {
    const privateKey = "agent:main:dashboard:incognito-old";
    const orphanedKey = "agent:main:subagent:incognito-metadata-only";
    const ordinaryKey = "agent:main:dashboard:retained";
    const database = await openDatabase(2, [SNAPSHOTS, METADATA]);
    database.close();
    for (const sessionKey of [privateKey, ordinaryKey]) {
      const { projectionVersion: _version, ...legacy } = envelope(sessionKey, snapshot(sessionKey));
      await putRawRecord(legacy);
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
    expect(await readRawRecord(privateKey, METADATA)).toBeUndefined();
    expect(await readRawRecord(orphanedKey, METADATA)).toBeUndefined();
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
    await persist(writer, sessionKey, persisted);

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
    await persist(writer, sessionKey, snapshot("persisted"));
    await persist(writer, sessionKey, snapshot(1n));
    expect(await new SessionSnapshotStore().read(sessionKey)).toBeNull();
  });

  it("suppresses unchanged writes only for the latest hydration", async () => {
    let now = 1;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const sessionKey = key("agent:main:hydrate-only");
    await persist(writer, sessionKey, snapshot("persisted"));
    expect((await readRawRecord(sessionKey))?.savedAt).toBe(1);
    now = 2;
    const memoryCache: ChatMessageCache = new Map();
    const reader = makeStore(memoryCache);
    const previousHydration = await reader.read(sessionKey);
    const hydrated = await reader.read(sessionKey);
    if (!previousHydration || !hydrated) {
      throw new Error("expected hydrated snapshot");
    }
    cacheSnapshot(memoryCache, sessionKey, hydrated);
    await reader.flush();
    expect((await readRawRecord(sessionKey))?.savedAt).toBe(1);
    reader.write(sessionKey, previousHydration);
    await reader.flush();
    expect((await readRawRecord(sessionKey))?.savedAt).toBe(2);
  });

  it("releases hydrated snapshots after the message cache evicts them", async () => {
    const sessionKey = key("agent:main:evicted-hydration");
    const memoryCache: ChatMessageCache = new Map();
    const store = makeStore(memoryCache);
    await persist(store, sessionKey, snapshot("persisted"));
    const { evicted, collectionControl } = await (async () => {
      const hydrated = await store.read(sessionKey);
      if (!hydrated) {
        throw new Error("expected hydrated snapshot");
      }
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

  it("evicts the oldest sessions by count and total serialized weight", async () => {
    let now = 0;
    vi.spyOn(Date, "now").mockImplementation(() => ++now);
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
      await persist(writer, valid, snapshot("valid"));
      await putRawRecord(
        {
          projectionVersion: 3,
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
      writer.connect();
      connected.add(writer);
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
    },
  );

  it("upgrades a version one database before deleting an invalidated snapshot", async () => {
    const sessionKey = key("agent:main:legacy-delete");
    const legacy = await openDatabase(1, [SNAPSHOTS]);
    const write = legacy.transaction(SNAPSHOTS, "readwrite");
    write.objectStore(SNAPSHOTS).put({ sessionKey });
    await transactionDone(write);
    legacy.close();
    await new SessionSnapshotStore().delete(sessionKey);
    const database = await openDatabase();
    expect(database.version).toBe(8);
    expect(Array.from(database.objectStoreNames)).toEqual([SIDEBAR, METADATA, SNAPSHOTS]);
    const transaction = database.transaction([SNAPSHOTS, METADATA], "readonly");
    const snapshotRequest = transaction.objectStore(SNAPSHOTS).get(sessionKey);
    const metadataRequest = transaction.objectStore(METADATA).get(sessionKey);
    const completed = transactionDone(transaction);
    await Promise.all([requestResult(snapshotRequest), requestResult(metadataRequest), completed]);
    expect(snapshotRequest.result).toBeUndefined();
    expect(metadataRequest.result).toBeUndefined();
    database.close();
  });

  it("upgrades unbounded transcripts without discarding the current sidebar", async () => {
    const oldDatabase = await openDatabase(7, [SNAPSHOTS, METADATA, SIDEBAR]);
    const transaction = oldDatabase.transaction([...oldDatabase.objectStoreNames], "readwrite");
    for (const name of oldDatabase.objectStoreNames) {
      transaction.objectStore(name).put({ sessionKey: "old", payload: "retained" });
    }
    await transactionDone(transaction);
    oldDatabase.close();
    const reader = new SessionSnapshotStore();
    await reader.loadSavedAtIndex();
    expect(await readRawRecord("old")).toBeUndefined();
    expect(await readRawRecord("old", METADATA)).toBeUndefined();
    expect(await readRawRecord("old", SIDEBAR)).toEqual({ sessionKey: "old", payload: "retained" });
  });

  it.each(["all", "session"] as const)(
    "broadcasts %s invalidation without clearing unrelated peer memory",
    async (scope) => {
      const deleted = key("agent:main:deleted-in-peer");
      const retained = key("agent:main:retained-in-peer");
      const memory: ChatMessageCache = new Map();
      const store = makeStore(memory, true);
      cacheSnapshot(memory, deleted);
      cacheSnapshot(memory, retained);
      await store.flush();
      const setItem = vi.spyOn(localStorage, "setItem");
      await (scope === "all" ? clearStoredChatSnapshots() : deleteStoredChatSnapshot(deleted));
      const broadcast = setItem.mock.calls.findLast(
        ([storageKey]) => storageKey === "openclaw.control.chatSnapshots.invalidate.v1",
      )?.[1];
      expect(broadcast).toBeDefined();
      if (scope === "all") {
        expect(broadcast).toBe("{}");
      }
      for (const peerValue of scope === "all" ? [broadcast, "1"] : [broadcast]) {
        cacheSnapshot(memory, deleted);
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
    },
  );

  it("retains persisted snapshots through a temporary database open failure", async () => {
    const sessionKey = key("agent:main:temporary-open-failure");
    const value = snapshot("Retained conversation");
    writer.write(sessionKey, value);
    await writer.flush();
    vi.spyOn(indexedDB, "open").mockImplementationOnce(() => {
      throw new DOMException("temporarily unavailable", "UnknownError");
    });

    const reader = new SessionSnapshotStore();
    expect(await reader.read(sessionKey)).toBeNull();
    expect(await reader.read(sessionKey)).toEqual(value);
  });

  it("rebuilds a missing snapshot store after a non-fatal read failure", async () => {
    const request = indexedDB.open(DB, 8);
    request.addEventListener("upgradeneeded", () => {
      for (const name of [METADATA, SIDEBAR]) {
        request.result.createObjectStore(name, { keyPath: "sessionKey" });
      }
    });
    const database = await requestResult(request);
    database.close();
    const sessionKey = key("agent:main:missing-snapshot-store");
    const store = new SessionSnapshotStore();
    expect(await store.read(sessionKey)).toBeNull();

    const value = snapshot("Rebuilt conversation");
    store.write(sessionKey, value);
    await store.flush();
    expect(await new SessionSnapshotStore().read(sessionKey)).toEqual(value);
  });

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
