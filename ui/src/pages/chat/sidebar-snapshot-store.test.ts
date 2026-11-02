import { IDBFactory, IDBObjectStore } from "fake-indexeddb";
import { afterEach, assert, beforeEach, expect, it, vi } from "vitest";
import { z } from "zod";
import { projectSidebarSession } from "../../components/app-sidebar-session-navigation.test-support.ts";
import { parseSidebarSnapshot, snapshotSessions } from "../../components/sidebar-snapshot-model.ts";
import { sidebarSnapshot } from "../../components/sidebar-snapshot.test-support.ts";
import { requestResult, transactionComplete } from "../../lib/chat/control-ui-database.runtime.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import {
  openSessionSnapshotDatabase,
  CHAT_SNAPSHOT_STORE_NAME as CHAT,
  CHAT_SNAPSHOT_METADATA_STORE_NAME as METADATA,
  SIDEBAR_SNAPSHOT_STORE_NAME as SIDEBAR,
} from "./session-snapshot-database.ts";
import {
  clearStoredChatSnapshots,
  deleteStoredChatSnapshot,
} from "./session-snapshot-invalidation.ts";
import { SessionSnapshotStore } from "./session-snapshot-store.ts";
/* @vitest-environment jsdom */
import { writeSnapshotFixture } from "./session-snapshot.test-support.ts";

const DB_NAME = "openclaw-chat-snapshots";
const scope = {
  gatewayScope: "wss://sidebar.example",
  recoveryScope: "account-a",
  profileId: "profile-a",
};
const key = (value: typeof scope) =>
  `scope:${JSON.stringify([value.gatewayScope, value.recoveryScope])}\u0000sidebar:${JSON.stringify(value.profileId)}`;
const modelSchema = z.object({ rows: z.array(z.string()) }).strict();
const validate = (value: unknown) => {
  const parsed = modelSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
};
const model = { rows: ["Agent Juniper", "Dashboard Cedar", "Calendar"] };
const profile = (profileId: string) => ({ ...scope, profileId });
const otherProfile = profile("profile-b");
const otherAccount = { ...scope, recoveryScope: "account-b" };
const accountPrefix = `scope:${JSON.stringify([scope.gatewayScope, scope.recoveryScope])}\u0000`;
const read = (store: SessionSnapshotStore, current = scope) =>
  store.readSidebar(key(current), validate);
const write = (store: SessionSnapshotStore, value = model, current = scope) =>
  store.writeSidebar(key(current), value, validate);
const sessionKey = `scope:${JSON.stringify([scope.gatewayScope, scope.recoveryScope])}\u0000agent:main:cedar`;

const stores: SessionSnapshotStore[] = [];
function createStore() {
  const store = new SessionSnapshotStore();
  store.connect();
  stores.push(store);
  return store;
}

async function seededStore() {
  const store = createStore();
  for (const current of [scope, otherProfile, otherAccount]) {
    await write(store, model, current);
  }
  return store;
}

async function putSidebar(value: unknown, savedAt: number, projectionVersion = 4) {
  const database = await openSessionSnapshotDatabase();
  assert(database, "expected snapshot database");
  const transaction = database.transaction(SIDEBAR, "readwrite");
  transaction
    .objectStore(SIDEBAR)
    .put({ sessionKey: key(scope), savedAt, projectionVersion, model: value });
  await transactionComplete(transaction);
  database.close();
}

beforeEach(() => {
  vi.stubGlobal("indexedDB", new IDBFactory());
  vi.stubGlobal("localStorage", createStorageMock());
});
afterEach(async () => {
  await clearStoredChatSnapshots();
  for (const store of stores.splice(0)) {
    store.disconnect();
    await store.whenIdle();
  }
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("retires pre-rail-identity sidebars", async () => {
  const request = indexedDB.open(DB_NAME, 6);
  request.addEventListener("upgradeneeded", () => {
    for (const name of [CHAT, METADATA, SIDEBAR]) {
      request.result.createObjectStore(name, { keyPath: "sessionKey" });
    }
  });
  const database = await requestResult(request);
  const transaction = database.transaction(SIDEBAR, "readwrite");
  transaction.objectStore(SIDEBAR).put({
    sessionKey: key(scope),
    savedAt: Date.now(),
    projectionVersion: 1,
    model,
  });
  await transactionComplete(transaction);
  database.close();

  expect(await read(createStore())).toBeNull();
});

it("restores the settled row order before a connection and isolates gateway, account and profile", async () => {
  const writer = createStore();
  const captured = { rows: [...model.rows] };
  const writing = write(writer, captured);
  captured.rows.reverse();
  expect(await writing).toBe(true);
  const reader = createStore();
  expect(await read(reader)).toEqual(model);
  for (const other of [
    { ...scope, gatewayScope: "wss://other.example" },
    otherAccount,
    otherProfile,
  ]) {
    expect(await read(reader, other)).toBeNull();
  }
});

it("decodes only the requested profile while bounding all retained envelopes", async () => {
  const store = await seededStore();
  const selected = vi.fn(validate);
  expect(await store.readSidebar(key(scope), selected)).toEqual(model);
  expect(selected).toHaveBeenCalledExactlyOnceWith(model);
  expect(await read(store, otherProfile)).toEqual(model);
});

it("writes each changed presentation once across independent tab stores", async () => {
  let now = 1000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  const first = createStore();
  const peer = createStore();
  const put = vi.spyOn(IDBObjectStore.prototype, "put");
  await Promise.all([write(first), write(peer)]);
  const changed = { rows: ["Retained conversation"] };
  await Promise.all([write(peer, changed), write(first, changed)]);
  expect(
    put.mock.calls.filter((_, index) => {
      const instance = put.mock.instances[index];
      return instance instanceof IDBObjectStore && instance.name === SIDEBAR;
    }),
  ).toHaveLength(2);
  expect(await read(peer)).toEqual(changed);
  now += 31 * 24 * 60 * 60 * 1000;
  expect(await write(first, changed)).toBe(true);
  expect(await read(peer)).toEqual(changed);
});

it.each([1, 2, 3])(
  "retires an incompatible sidebar version %i without evicting valid caches",
  async (projectionVersion) => {
    vi.spyOn(Date, "now").mockReturnValue(1000);
    const store = createStore();
    const profiles = Array.from({ length: 8 }, (_, index) => profile(`retained-${index}`));
    for (const current of profiles) {
      await store.writeSidebar(key(current), sidebarSnapshot, parseSidebarSnapshot);
    }
    const transcript = {
      messages: ["Retained conversation"],
      pagination: { hasMore: false as const },
      sessionId: "cedar",
    };
    writeSnapshotFixture(store, sessionKey, transcript);
    await store.flush();
    const [parent, child] = snapshotSessions(
      ["parent", "child"].map((name) =>
        projectSidebarSession({ key: `agent:main:${name}`, label: name }),
      ),
    );
    const legacy = { ...sidebarSnapshot, pinnedSessions: [{ ...parent!, children: [child!] }] };
    expect(parseSidebarSnapshot(legacy)).toBeNull();
    await putSidebar(legacy, 2000, projectionVersion);

    expect(await store.readSidebar(key(scope), parseSidebarSnapshot)).toBeNull();
    for (const current of profiles) {
      expect(await store.readSidebar(key(current), parseSidebarSnapshot)).toEqual(sidebarSnapshot);
    }
    expect(await store.read(sessionKey)).toMatchObject(transcript);
  },
);

it("prunes oldest records by count, UTF-8 bytes, and age", async () => {
  let now = 1;
  vi.spyOn(Date, "now").mockImplementation(() => now++);
  const store = createStore();
  for (let index = 0; index < 9; index += 1) {
    await write(store, model, profile(`profile-${index}`));
  }
  expect(await read(store, profile("profile-0"))).toBeNull();
  expect(await read(store, profile("profile-1"))).toEqual(model);
  await clearStoredChatSnapshots();
  const large = { rows: ["🦞".repeat(70_000)] };
  await write(store, large);
  await write(store, large, profile("newer"));
  expect(await read(store)).toBeNull();
  expect(await read(store, profile("newer"))).toEqual(large);
  await write(store, { rows: ["🦞".repeat(140_000)] });
  expect(await read(store)).toBeNull();
  now += 31 * 24 * 60 * 60 * 1000;
  expect(await read(store, profile("newer"))).toBeNull();
});

it("removes only the evicted transcript", async () => {
  const transcripts = new SessionSnapshotStore();
  const snapshot = {
    messages: ["synthetic"],
    pagination: { hasMore: false as const },
    sessionId: "cedar",
  };
  const retained = `${sessionKey}-retained`;
  writeSnapshotFixture(transcripts, sessionKey, snapshot);
  writeSnapshotFixture(transcripts, retained, snapshot);
  await transcripts.flush();
  await deleteStoredChatSnapshot(sessionKey, "cache-eviction");
  expect(await transcripts.read(sessionKey)).toBeNull();
  expect(await transcripts.read(retained)).toEqual(snapshot);
});

it.each(["profile", "account", "session", "cache-eviction", "all"] as const)(
  "fences queued writes and already-read values across %s invalidation",
  async (kind) => {
    const store = await seededStore();
    const invalidate = () =>
      kind === "profile"
        ? store.delete(key(scope))
        : kind === "session" || kind === "cache-eviction"
          ? deleteStoredChatSnapshot(sessionKey, kind === "cache-eviction" ? kind : undefined)
          : clearStoredChatSnapshots(kind === "account" ? accountPrefix : undefined);
    await Promise.all([write(store), invalidate()]);
    const expected = kind === "cache-eviction" ? model : null;
    expect(await read(store)).toEqual(expected);
    expect(await read(store, otherProfile)).toEqual(
      kind === "profile" || kind === "cache-eviction" ? model : null,
    );
    expect(await read(store, otherAccount)).toEqual(kind === "all" ? null : model);
    await write(store);
    let invalidation: Promise<void> | undefined;
    const getAll = vi.spyOn(IDBObjectStore.prototype, "getAll");
    getAll.mockImplementationOnce(function (this: IDBObjectStore, ...args) {
      getAll.mockRestore();
      const request = this.getAll(...args);
      request.addEventListener("success", () => {
        invalidation = invalidate();
      });
      return request;
    });
    expect(await read(store)).toEqual(expected);
    expect(invalidation).toBeDefined();
    await invalidation;
    expect(await read(createStore())).toEqual(expected);
  },
);

it("resets a mismatched stored projection and rejects unadmitted display data", async () => {
  const store = createStore();
  await write(store);
  await putSidebar(model, 1, 99);
  expect(await read(store)).toBeNull();
  const unadmitted = { ...model, token: "synthetic-disallowed-field" };
  await write(store, unadmitted);
  expect(await read(store)).toBeNull();
});

it("treats unavailable persistence as a cache miss and stops work after disconnect", async () => {
  const store = createStore();
  const writing = write(store);
  store.disconnect();
  store.connect();
  await store.whenIdle();
  await writing;
  expect(await read(createStore())).toBeNull();
  await write(store);
  expect(await read(store)).toEqual(model);
  vi.stubGlobal("indexedDB", undefined);
  const unavailable = createStore();
  await expect(write(unavailable)).resolves.toBe(false);
  expect(await read(unavailable)).toBeNull();
});

it("keeps the sidebar and unrelated chats when a deleted session is pruned from every display copy", async () => {
  const store = createStore();
  const [removed, retained] = snapshotSessions(
    ["cedar", "retained"].map((name) =>
      projectSidebarSession({ key: `agent:main:${name}`, label: name }),
    ),
  );
  assert(removed && retained);
  const saved = {
    ...sidebarSnapshot,
    pinnedSessions: [
      removed,
      { ...retained, childLoadParentKeys: [removed.key], children: [removed] },
    ],
    pages: [removed, retained],
    entries: [`session:${removed.key}`, `session:${retained.key}`, "route:usage"],
  };
  await store.writeSidebar(key(scope), saved, parseSidebarSnapshot);
  await store.writeSidebar(key(otherAccount), saved, parseSidebarSnapshot);
  const transcript = {
    messages: ["retained"],
    pagination: { hasMore: false as const },
    sessionId: "retained",
  };
  writeSnapshotFixture(store, `${accountPrefix}${retained.key}`, transcript);
  await store.flush();
  await deleteStoredChatSnapshot(sessionKey);
  const restored = await store.readSidebar(key(scope), parseSidebarSnapshot);
  assert(restored, "deleting one session must retain the sidebar");
  expect(restored.pages.map((row) => row.key)).toEqual([retained.key]);
  expect(restored.pinnedSessions.map((row) => row.key)).toEqual([retained.key]);
  expect(restored.pinnedSessions[0]?.children).toEqual([]);
  expect(restored.entries).toEqual([`session:${retained.key}`, "route:usage"]);
  expect(await store.readSidebar(key(otherAccount), parseSidebarSnapshot)).toEqual(saved);
  expect(await store.read(`${accountPrefix}${retained.key}`)).toEqual(transcript);
});
