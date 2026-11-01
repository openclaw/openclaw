/* @vitest-environment jsdom */

import { Blob as NodeBlob } from "node:buffer";
import { assert, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { parseSidebarSnapshot } from "../../components/sidebar-snapshot-data.ts";
import { sidebarSnapshot } from "../../components/sidebar-snapshot.test-support.ts";
import {
  requestResult,
  transactionComplete as transactionDone,
} from "../../lib/chat/control-ui-database.runtime.ts";
import { chatThumbnailWeight } from "../../lib/chat/row-display-facts.ts";
import { cacheChatBoardSnapshotAfterHydration } from "./chat-board-snapshot.ts";
import { prewarmChatSnapshot } from "./chat-snapshot-prewarm.ts";
import {
  cacheChatSessionSnapshot,
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
import { CHAT_SNAPSHOT_PROJECTION_VERSION } from "./session-snapshot-record.ts";
import {
  cacheSnapshot,
  key,
  persist,
  rawKey,
  readSnapshot,
  sessionKey,
  snapshot,
  snapshotHost,
  useSessionSnapshotStoreFixture,
} from "./session-snapshot-store.test-support.ts";
import { SessionSnapshotStore } from "./session-snapshot-store.ts";
import { writeSnapshotFixture } from "./session-snapshot.test-support.ts";

const DB = "openclaw-chat-snapshots";
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

const envelope = (cacheKey: string, value: ChatSessionSnapshot, projectionVersion?: number) => ({
  projectionVersion: projectionVersion ?? CHAT_SNAPSHOT_PROJECTION_VERSION,
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
  it("restores conversation display facts and bytes within their account scope", async () => {
    // fake-indexeddb uses Node structured clone; jsdom's Blob is not cloneable there.
    vi.stubGlobal("Blob", NodeBlob);
    const thumbnail = new Blob([new Uint8Array([1, 2, 3])], { type: "image/webp" });
    const saved = {
      ...snapshot({ role: "assistant", content: "Synthetic image", __openclaw: { id: "reply" } }),
      rowDisplay: {
        reply: {
          links: { "session:agent:main:linked": { title: "Synthetic linked task" } },
          images: { source: { width: 480, height: 240, rendition: 480 as const, thumbnail } },
        },
      },
    };
    await seed(saved);
    const restored = await readSnapshot();
    expect(restored?.rowDisplay?.reply?.links).toEqual(saved.rowDisplay.reply.links);
    const image = restored?.rowDisplay?.reply?.images?.source;
    expect(image).toMatchObject({ width: 480, height: 240, rendition: 480 });
    expect(await image?.thumbnail?.arrayBuffer()).toEqual(await thumbnail.arrayBuffer());
    const otherAccountKey = resolveChatSnapshotKey(
      { ...snapshotHost, client: { recoveryScope: "account-b", recoveryScopeReady: true } },
      { sessionKey: rawKey(sessionKey) },
    );
    expect(await readSnapshot(otherAccountKey)).toBeNull();
    const other = key("agent:main:other");
    await seed({ ...saved, sessionId: "other" }, other);
    await clearStoredChatSnapshots(sessionKey.slice(0, sessionKey.indexOf("\u0000") + 1));
    expect(await readSnapshot()).toBeNull();
    expect(await readSnapshot(other)).toBeNull();
  });

  it("evicts old thumbnail bytes at the global budget without evicting transcript rows", async () => {
    vi.stubGlobal("Blob", NodeBlob);
    const thumbnail = new Blob([new Uint8Array(256 * 1024)], { type: "image/webp" });
    const make = (prefix: string, count: number): ChatSessionSnapshot => ({
      ...snapshot(),
      messages: Array.from({ length: count }, (_, index) => ({
        role: "assistant",
        content: "Synthetic image",
        __openclaw: { id: `${prefix}-${index}` },
      })),
      rowDisplay: Object.fromEntries(
        Array.from({ length: count }, (_, index) => [
          `${prefix}-${index}`,
          { images: { source: { width: 960, height: 480, rendition: 960 as const, thumbnail } } },
        ]),
      ),
    });
    const writer = new SessionSnapshotStore();
    await persist(writer, sessionKey, make("old", 32));
    const nextKey = key("agent:main:new");
    await persist(writer, nextKey, make("new", 1));
    const old = await readSnapshot();
    const next = await readSnapshot(nextKey);
    expect(old?.messages).toHaveLength(32);
    expect(next?.messages).toHaveLength(1);
    expect(chatThumbnailWeight(old ?? {}).count + chatThumbnailWeight(next ?? {}).count).toBe(32);
    expect(chatThumbnailWeight(old ?? {}).bytes + chatThumbnailWeight(next ?? {}).bytes).toBe(
      8 * 1024 * 1024,
    );
    expect(next?.rowDisplay?.["new-0"]?.images?.source?.thumbnail).toBeInstanceOf(Blob);
  });

  let writer: SessionSnapshotStore;
  const seed = async (value = snapshot(), cacheKey = sessionKey) =>
    persist(writer, cacheKey, value);
  const { connected, makeStore } = useSessionSnapshotStoreFixture();
  beforeEach(() => {
    writer = makeStore();
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

  it.each<Partial<ChatSessionSnapshot>>([
    {
      composer: {
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
      },
    },
    {
      board: {
        receivedAtMs: 100,
        snapshot: {
          sessionKey: "s",
          widgets: [
            { frameUrl: "/widget?bt=ticket", viewTicket: "ticket", viewTicketTtlMs: 1200000 },
          ],
        },
      },
    },
  ])("restores scoped display facts with their original receipts (%j)", async (facts) => {
    const value = { ...snapshot(), ...facts };
    await seed(value);
    expect(await readSnapshot()).toEqual(value);
    const otherKey = resolveChatSnapshotKey(
      { ...snapshotHost, client: { recoveryScope: "account-b", recoveryScopeReady: true } },
      { sessionKey: rawKey(sessionKey) },
    );
    expect(await readSnapshot(otherKey)).toBeNull();
    await deleteStoredChatSnapshot(sessionKey);
    expect(await readSnapshot()).toBeNull();
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
    await putRawRecord(envelope(sessionKey, snapshot("old"), 10));
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
  ])(
    "rejects corrupt %s while retaining unrelated transcripts for record-local corruption",
    async (corruption, value) => {
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
      expect(await reader.read(valid)).toEqual(
        corruption === "metadata" ? null : snapshot("valid"),
      );
    },
  );

  it.each(["unrelated", "session", "cache-eviction", "all"] as const)(
    "settles an in-flight transcript through %s invalidation",
    async (scope) => {
      const value: ChatSessionSnapshot = {
        ...snapshot("important transcript"),
        headerSharing: "public",
        headerViewers: {
          users: [{ id: "peer", avatarUrl: "/peer.png" }],
          totalCount: 5,
          ownerViewing: true,
        },
      };
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
