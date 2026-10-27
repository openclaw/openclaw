import { IDBFactory } from "fake-indexeddb";
import { afterEach, assert, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { parseSidebarSnapshot } from "../../components/sidebar-snapshot-data.ts";
import { sidebarSnapshot } from "../../components/sidebar-snapshot.test-support.ts";
import {
  requestResult,
  transactionComplete as transactionDone,
} from "../../lib/chat/control-ui-database.runtime.ts";
import { collectGarbageForTest } from "../../test-helpers/garbage-collection.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import { cacheChatBoardSnapshotAfterHydration } from "./chat-board-snapshot.ts";
import { MAX_CACHED_CHAT_SESSIONS } from "./session-cache.ts";
import {
  cacheChatSessionSnapshot,
  observeChatCache,
  readChatSessionSnapshot,
  type ChatMessageCache,
  type ChatSessionSnapshot,
} from "./session-message-cache.ts";
import {
  CHAT_SNAPSHOT_METADATA_STORE_NAME as METADATA,
  CHAT_SNAPSHOT_STORE_NAME as SNAPSHOTS,
  SIDEBAR_SNAPSHOT_STORE_NAME as SIDEBAR,
  readStoredChatSnapshotRecord,
} from "./session-snapshot-database.ts";
import * as snapshotDatabase from "./session-snapshot-database.ts";
import {
  clearStoredChatSnapshots,
  deleteStoredChatSnapshot,
} from "./session-snapshot-invalidation.ts";
import { resolveChatSnapshotKey } from "./session-snapshot-key.ts";
import { prewarmChatSnapshot } from "./session-snapshot-prewarm.ts";
import { SessionSnapshotStore } from "./session-snapshot-store.ts";
/* @vitest-environment jsdom */
import { writeSnapshotFixture } from "./session-snapshot.test-support.ts";

const DB = "openclaw-chat-snapshots";
const snapshotHost = {
  settings: { gatewayUrl: "wss://cache.example" },
  client: { recoveryScope: "account-a", recoveryScopeReady: true },
  assistantAgentId: "main",
  agentsList: null,
  hello: null,
};
const key = (sessionKey: string) => resolveChatSnapshotKey(snapshotHost, { sessionKey });
const rawKey = (cacheKey: string) => cacheKey.slice(cacheKey.indexOf("\u0000") + 1);
const sessionKey = key("agent:main:session");
function snapshot(message: unknown = "conversation", sessionId = "session-1"): ChatSessionSnapshot {
  return {
    displayedLeafEntryId: "leaf-1",
    messages: [message],
    pagination: { hasMore: true, nextOffset: 1, totalMessages: 2 },
    sessionId,
  };
}

const readSnapshot = (cacheKey = sessionKey) => new SessionSnapshotStore().read(cacheKey);
function boardSnapshot(cacheKey: string, message: string, receivedAtMs = 100) {
  return {
    ...snapshot(message),
    board: {
      snapshot: { sessionKey: rawKey(cacheKey), revision: 1, tabs: [], widgets: [] },
      receivedAtMs,
    },
  };
}

function historyState(content: unknown, commands = true): ChatSessionSnapshot["historyState"] {
  const message = { role: "user", content };
  return {
    stateRevision: {
      pendingInputs: "inputs-1",
      sessionInfo: "info-1",
      ...(commands ? { commands: "commands-1" } : {}),
    },
    ...(commands
      ? {
          commands: [
            { name: "x", description: "", source: "skill", scope: "text", acceptsArgs: true },
          ],
        }
      : {}),
    pendingInputs: commands
      ? {
          items: [{ id: "i", acceptedAt: 1, state: "queued", queued: true, message }],
          total: 1,
          queuedCount: 1,
        }
      : { items: [], total: 0 },
    sessionInfo: { key: "s", kind: "direct", sessionId: "session-1", updatedAt: 1 },
  };
}

function cacheSnapshot(memory: ChatMessageCache, cacheKey: string, value = snapshot(cacheKey)) {
  cacheChatSessionSnapshot(memory, snapshotHost, { sessionKey: rawKey(cacheKey) }, value);
}
async function persist(store: SessionSnapshotStore, cacheKey: string, value: ChatSessionSnapshot) {
  writeSnapshotFixture(store, cacheKey, value);
  await store.flush();
}
const envelope = (cacheKey: string, value: ChatSessionSnapshot, projectionVersion = 6) => ({
  projectionVersion,
  sessionKey: cacheKey,
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

async function putRawRecord(
  record: unknown,
  metadata?: unknown,
  storeName = SNAPSHOTS,
): Promise<void> {
  const database = await openDatabase();
  const transaction = database.transaction(
    storeName === SNAPSHOTS ? [SNAPSHOTS, METADATA] : storeName,
    "readwrite",
  );
  const completed = transactionDone(transaction);
  transaction.objectStore(storeName).put(record);
  if (storeName === SNAPSHOTS) {
    transaction.objectStore(METADATA).put(
      metadata ?? {
        savedAt: Date.now(),
        sessionKey: (record as { sessionKey: string }).sessionKey,
        weight: 0,
      },
    );
  }
  await completed;
  database.close();
}

async function readRawRecord(
  cacheKey: string,
  storeName = SNAPSHOTS,
): Promise<{ savedAt: number; weight?: number } | undefined> {
  const database = await openDatabase();
  const transaction = database.transaction(storeName, "readonly");
  const result = await requestResult<{ savedAt: number; weight?: number } | undefined>(
    transaction.objectStore(storeName).get(cacheKey),
  );
  await transactionDone(transaction);
  database.close();
  return result;
}

describe("persistent chat session snapshots", () => {
  it("restores model display data with the conversation, isolated from another account", async () => {
    const writer = new SessionSnapshotStore();
    const remembered: NonNullable<ChatSessionSnapshot["composer"]> = {
      id: "model",
      provider: "openai",
      name: "Remembered model",
      reasoning: true,
      speed: { active: false, currentOverride: "off", label: "Standard", supported: true },
      thinkingLevel: "high",
      thinkingDefault: "medium",
      thinkingLevels: [{ id: "high", label: "High" }],
      permissionMode: "full",
      defaultPermissionMode: "workspace",
    };
    await persist(writer, sessionKey, { ...snapshot(), composer: remembered });
    expect((await readSnapshot())?.composer).toEqual(remembered);
    const otherKey = resolveChatSnapshotKey(
      { ...snapshotHost, client: { recoveryScope: "account-b", recoveryScopeReady: true } },
      { sessionKey: rawKey(sessionKey) },
    );
    expect(await readSnapshot(otherKey)).toBeNull();
  });
  let writer: SessionSnapshotStore;
  const seed = async (value = snapshot(), cacheKey = sessionKey) =>
    persist(writer, cacheKey, value);
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

  it("releases one read scope without retiring another reader or its replacement", () => {
    const first = writer.captureReadScope(sessionKey);
    const second = writer.captureReadScope(sessionKey);
    expect([first.isCurrent(), second.isCurrent()]).toEqual([true, true]);
    first.dispose();
    first.dispose();
    expect([first.isCurrent(), second.isCurrent()]).toEqual([false, true]);
    second.dispose();

    const replacement = writer.captureReadScope(sessionKey);
    expect([first.isCurrent(), second.isCurrent(), replacement.isCurrent()]).toEqual([
      false,
      false,
      true,
    ]);
    replacement.dispose();
  });

  it.each(["write", "forget", "prefix", "clear", "sidebar", "disconnect"] as const)(
    "keeps an old read scope retired after %s and recapture",
    (operation) => {
      const target =
        operation === "sidebar" || operation === "disconnect"
          ? `${sessionKey.split("\u0000")[0]}\u0000sidebar:operator`
          : sessionKey;
      const store = makeStore(undefined, operation === "disconnect");
      const retired = store.captureReadScope(target);
      const unrelated = store.captureReadScope(key("agent:main:unrelated"));
      if (operation === "write") {
        writeSnapshotFixture(store, target, snapshot());
      } else if (operation === "forget") {
        store.forget(target);
      } else if (operation === "prefix") {
        store.forgetScope(target);
      } else if (operation === "clear") {
        store.clearMemory();
      } else if (operation === "sidebar") {
        store.forgetSidebar({ sessionKey });
      } else {
        store.disconnect();
      }
      expect(retired.isCurrent()).toBe(false);
      const replacement = store.captureReadScope(target);
      retired.dispose();
      expect(retired.isCurrent()).toBe(false);
      expect(replacement.isCurrent()).toBe(true);
      expect(unrelated.isCurrent()).toBe(operation !== "clear");
      unrelated.dispose();
      replacement.dispose();
      store.clearMemory();
    },
  );

  it.each([false, true])(
    "preserves queued snapshot admission through read-scope churn (forgotten=%s)",
    async (forgotten) => {
      await seed();
      const database = await openDatabase();
      const held = createDeferred<IDBDatabase | null>();
      const opening = vi
        .spyOn(snapshotDatabase, "openSessionSnapshotDatabase")
        .mockReturnValueOnce(held.promise);
      writeSnapshotFixture(writer, key("agent:main:blocker"), snapshot("blocker"));
      const blocker = writer.flush();
      await vi.waitFor(() => expect(opening).toHaveBeenCalledOnce());
      const target = key("agent:main:queued");
      const value = snapshot("queued");
      writeSnapshotFixture(writer, target, value);
      const queued = writer.flush();
      if (forgotten) {
        writer.forget(target);
      }
      for (let index = 0; index < 100; index += 1) {
        const scope = writer.captureReadScope(key(`agent:main:churn-${index}`));
        scope.dispose();
      }
      const replacement = writer.captureReadScope(target);
      held.resolve(database);
      await Promise.all([blocker, queued]);
      expect(replacement.isCurrent()).toBe(true);
      replacement.dispose();
      expect(await readSnapshot(target)).toEqual(forgotten ? null : value);
    },
  );

  it("restores a board snapshot and its original ticket receipt with the conversation", async () => {
    const value: ChatSessionSnapshot = {
      ...snapshot("dashboard conversation"),
      board: {
        receivedAtMs: 100,
        snapshot: {
          sessionKey: "s",
          widgets: [
            { frameUrl: "/widget?bt=ticket", viewTicket: "ticket", viewTicketTtlMs: 1200000 },
          ],
        },
      },
    };
    await seed(value);
    expect(await new SessionSnapshotStore().read(sessionKey)).toEqual(value);
    await deleteStoredChatSnapshot(sessionKey);
    expect(await new SessionSnapshotStore().read(sessionKey)).toBeNull();
  });

  it("does not return a cached board after its pending read is invalidated", async () => {
    await seed({
      ...boardSnapshot(sessionKey, "retired conversation"),
      historyState: { stateRevision: {}, commands: [] },
    });
    const reader = new SessionSnapshotStore();
    const reading = reader.read(sessionKey);
    reader.forget(sessionKey);
    expect(await reading).toBeNull();
  });

  it("persists board removal before any transcript is in memory", async () => {
    const memory: ChatMessageCache = new Map();
    const store = makeStore(memory);
    await seed(boardSnapshot(sessionKey, "saved conversation"));
    cacheChatBoardSnapshotAfterHydration(
      { ...snapshotHost, chatMessagesBySession: memory },
      { sessionKey: rawKey(sessionKey) },
      null,
      100,
      () => true,
    );
    await store.flush();
    expect((await new SessionSnapshotStore().read(sessionKey))?.board).toBeNull();
  });

  it.each(["plain", "pairing", "legacy"])(
    "persists raw metadata with its receipts unless privacy projection changes it (%s)",
    async (mode) => {
      const value: ChatSessionSnapshot = {
        ...snapshot("history"),
        deltaCursor: "cursor-1",
        historyState: historyState(
          mode === "pairing"
            ? [{ type: "openclaw_pairing_qr", data: "synthetic-private-pairing" }]
            : "Follow up.",
          mode !== "legacy",
        ),
      };
      await seed(value);
      const restored = await new SessionSnapshotStore().read(sessionKey);
      expect(restored?.deltaCursor).toBe("cursor-1");
      expect(restored?.historyState).toEqual(mode === "pairing" ? undefined : value.historyState);
      expect(JSON.stringify(await readStoredChatSnapshotRecord(sessionKey))).not.toContain(
        "synthetic-private-pairing",
      );
    },
  );

  it("defaults omitted sidebar presence preferences in the current projection", async () => {
    const store = makeStore(undefined, true);
    const sidebarKey = `${key("").split("\u0000")[0]}\u0000sidebar:operator`;
    expect(await store.writeSidebar(sidebarKey, sidebarSnapshot, parseSidebarSnapshot)).toBe(true);
    await putRawRecord(
      {
        sessionKey: sidebarKey,
        projectionVersion: 3,
        savedAt: Date.now(),
        model: { ...sidebarSnapshot, peoplePresenceFilter: undefined, offlineUsers: undefined },
      },
      undefined,
      SIDEBAR,
    );
    const restored = await store.readSidebar(sidebarKey, parseSidebarSnapshot);
    expect(restored).toMatchObject({ peoplePresenceFilter: "online", offlineUsers: [] });
  });

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

  it("isolates account-less snapshots by client or host identity", () => {
    const memory: ChatMessageCache = new Map();
    const target = { sessionKey: "agent:main:unowned" };
    const client = { recoveryScope: "", recoveryScopeReady: false };
    const host = { ...snapshotHost, client };
    const clientSnapshot = snapshot("client-owned");
    cacheChatSessionSnapshot(memory, host, target, clientSnapshot);
    expect(readChatSessionSnapshot(memory, host, target)).toEqual(clientSnapshot);
    expect(readChatSessionSnapshot(memory, { ...host }, target)).toEqual(clientSnapshot);
    expect(readChatSessionSnapshot(memory, { ...host, client: { ...client } }, target)).toBeNull();

    const noClientHost = { ...snapshotHost, client: undefined };
    expect(readChatSessionSnapshot(memory, noClientHost, target)).toBeNull();
    const hostSnapshot = snapshot("host-owned");
    cacheChatSessionSnapshot(memory, noClientHost, target, hostSnapshot);
    expect(readChatSessionSnapshot(memory, noClientHost, target)).toEqual(hostSnapshot);
    expect(readChatSessionSnapshot(memory, { ...noClientHost }, target)).toBeNull();
    expect(readChatSessionSnapshot(memory, host, target)).toEqual(clientSnapshot);
  });

  it("keeps Incognito history in memory without persisting snapshots or metadata", async () => {
    const memory: ChatMessageCache = new Map();
    writer = makeStore(memory);
    const privateKey = key("agent:main:dashboard:incognito-private");
    const ordinaryKey = key("agent:main:dashboard:ordinary");
    cacheSnapshot(memory, ordinaryKey);
    const ordinaryFlush = writer.flush();
    cacheSnapshot(memory, privateKey);
    await Promise.all([ordinaryFlush, writer.flush()]);
    const reader = new SessionSnapshotStore();
    await reader.loadSavedAtIndex();
    expect(memory.get(privateKey)?.snapshot).toEqual(snapshot(privateKey));
    expect(await readRawRecord(privateKey)).toBeUndefined();
    expect(await readRawRecord(privateKey, METADATA)).toBeUndefined();
    expect(writer.readSavedAt(privateKey)).toBeNull();
    expect(reader.readSavedAt(privateKey)).toBeNull();
    expect(await reader.read(privateKey)).toBeNull();
    expect(await reader.read(ordinaryKey)).toEqual(snapshot(ordinaryKey));
    expect(reader.readSavedAt(ordinaryKey)).not.toBeNull();
  });

  it("refuses Incognito records through direct reads and routed prewarm", async () => {
    const privateKey = key("agent:main:dashboard:incognito-existing");
    await persist(writer, key("agent:main:ordinary"), snapshot("ordinary"));
    // A foreign/older writer must not make private records readable by this UI.
    await putRawRecord(envelope(privateKey, snapshot("private")));
    expect(await readStoredChatSnapshotRecord(privateKey)).toBeUndefined();
    void prewarmChatSnapshot(privateKey);
    expect(await new SessionSnapshotStore().read(privateKey)).toBeNull();
  });

  it.each(["direct", "prewarmed"])("discards the previous projection (%s)", async (mode) => {
    await persist(writer, sessionKey, snapshot("current"));
    await putRawRecord(envelope(sessionKey, snapshot("old"), 4));
    if (mode === "prewarmed") {
      void prewarmChatSnapshot(sessionKey);
    }
    expect(await new SessionSnapshotStore().read(sessionKey)).toBeNull();
  });

  it("purges all legacy unscoped history rather than adopting an unknown account", async () => {
    const privateKey = "agent:main:dashboard:incognito-old";
    const orphanedKey = "agent:main:subagent:incognito-metadata-only";
    const ordinaryKey = "agent:main:dashboard:retained";
    const database = await openDatabase(2, [SNAPSHOTS, METADATA]);
    database.close();
    for (const cacheKey of [privateKey, ordinaryKey]) {
      const { projectionVersion: _version, ...legacy } = envelope(cacheKey, snapshot(cacheKey));
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
    void prewarmChatSnapshot(privateKey);
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

  it("defers snapshot sanitization until flush", async () => {
    writer.connect();
    connected.add(writer);
    await seed();
    await seed(snapshot(1n));
    expect(await new SessionSnapshotStore().read(sessionKey)).toBeNull();
  });

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

  it("suppresses unchanged writes only for the latest hydration", async () => {
    let now = 1;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    await seed();
    expect((await readRawRecord(sessionKey))?.savedAt).toBe(1);
    now = 2;
    const memoryCache: ChatMessageCache = new Map();
    const reader = makeStore(memoryCache);
    const previousHydration = await reader.read(sessionKey);
    const hydrated = await reader.read(sessionKey);
    assert.isNotNull(previousHydration);
    assert.isNotNull(hydrated);
    const scope = reader.captureReadScope(sessionKey);
    cacheSnapshot(memoryCache, sessionKey, hydrated);
    expect(scope.isCurrent()).toBe(false);
    scope.dispose();
    await reader.flush();
    expect((await readRawRecord(sessionKey))?.savedAt).toBe(1);
    writeSnapshotFixture(reader, sessionKey, previousHydration);
    await reader.flush();
    expect((await readRawRecord(sessionKey))?.savedAt).toBe(2);
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

  it.each([
    { limit: 21, message: "small" },
    { limit: 3, message: "x".repeat(9 * 1024 * 1024) },
  ])("evicts oldest snapshots at the $limit-record budget", async ({ limit, message }) => {
    let now = 0;
    vi.spyOn(Date, "now").mockImplementation(() => ++now);
    for (let index = 0; index < limit; index += 1) {
      await seed(snapshot(message, `${index}`), key(`agent:main:${index}`));
    }
    expect(writer.readSavedAt(key("agent:main:0"))).toBeNull();
    expect(await readSnapshot(key("agent:main:0"))).toBeNull();
    expect(await readSnapshot(key(`agent:main:${limit - 1}`))).not.toBeNull();
  });

  it.each([
    ["snapshot", { messages: "not-an-array" }],
    ["metadata", snapshot()],
    ["board", boardSnapshot("dashboard", "conversation", -1)],
    [
      "history",
      {
        ...snapshot(),
        historyState: {
          stateRevision: { sessionInfo: "info-1" },
          sessionInfo: { key: "s", kind: "direct", owner: { actor: { type: "unknown" } } },
        },
      },
    ],
  ])("resets corrupt %s without hydrating unrelated transcripts", async (corruption, value) => {
    const valid = key("agent:main:valid");
    const corrupt = key("agent:main:corrupt");
    await persist(writer, valid, snapshot("valid"));
    await putRawRecord(
      { ...envelope(corrupt, snapshot()), snapshot: value },
      corruption === "metadata"
        ? { sessionKey: corrupt, savedAt: "invalid", weight: 0 }
        : undefined,
    );
    const reader = new SessionSnapshotStore();
    await reader.loadSavedAtIndex();
    if (corruption !== "metadata") {
      expect(reader.readSavedAt(valid)).not.toBeNull();
      expect(reader.readSavedAt(corrupt)).not.toBeNull();
      expect(await reader.read(corrupt)).toBeNull();
    } else {
      expect(reader.readSavedAt(corrupt)).toBeNull();
    }
    expect(await readStoredChatSnapshotRecord(corrupt)).toBeUndefined();
    expect(await reader.read(valid)).toBeNull();
  });

  it.each(["unrelated", "session", "cache-eviction", "all"] as const)(
    "settles an in-flight transcript through %s invalidation",
    async (scope) => {
      const value = snapshot("important transcript");
      writer.connect();
      connected.add(writer);
      writeSnapshotFixture(writer, sessionKey, value);
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

  it.each([1, 7])("upgrades schema v%s without retaining obsolete transcripts", async (version) => {
    const names = version === 1 ? [SNAPSHOTS] : [SNAPSHOTS, METADATA, SIDEBAR];
    const database = await openDatabase(version, names);
    const transaction = database.transaction(names, "readwrite");
    const record = { sessionKey, payload: "retained" };
    for (const name of names) {
      transaction.objectStore(name).put(record);
    }
    await transactionDone(transaction);
    database.close();
    const reader = new SessionSnapshotStore();
    await (version === 1 ? reader.delete(sessionKey) : reader.loadSavedAtIndex());
    expect(await readRawRecord(sessionKey)).toBeUndefined();
    expect(await readRawRecord(sessionKey, METADATA)).toBeUndefined();
    if (version === 7) {
      expect(await readRawRecord(sessionKey, SIDEBAR)).toEqual(record);
    }
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
    const value = snapshot("Retained conversation");
    await seed(value);
    vi.spyOn(indexedDB, "open").mockImplementationOnce(() => {
      throw new DOMException("temporarily unavailable", "UnknownError");
    });

    const reader = new SessionSnapshotStore();
    expect(await reader.read(sessionKey)).toBeNull();
    expect(await reader.read(sessionKey)).toEqual(value);
  });

  it("rebuilds a missing snapshot store after a non-fatal read failure", async () => {
    const database = await openDatabase(8, [METADATA, SIDEBAR]);
    database.close();
    const store = new SessionSnapshotStore();
    expect(await store.read(sessionKey)).toBeNull();

    const value = snapshot("Rebuilt conversation");
    await persist(store, sessionKey, value);
    expect(await new SessionSnapshotStore().read(sessionKey)).toEqual(value);
  });

  it("keeps every operation non-fatal when IndexedDB is unavailable or throws", async () => {
    vi.stubGlobal("indexedDB", undefined);
    const unavailable = new SessionSnapshotStore();
    writeSnapshotFixture(unavailable, key("agent:main:none"), snapshot("none"));
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
    writeSnapshotFixture(denied, key("agent:main:denied"), snapshot("denied"));
    await expect(denied.flush()).resolves.toBeUndefined();
    await expect(denied.read(key("agent:main:denied"))).resolves.toBeNull();
    await expect(clearStoredChatSnapshots()).resolves.toBeUndefined();
  });
});
