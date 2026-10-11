/* @vitest-environment jsdom */
import { IDBFactory, IDBObjectStore } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { requestResult, transactionComplete } from "../../lib/chat/control-ui-database.runtime.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import {
  openSessionSnapshotDatabase,
  SIDEBAR_SNAPSHOT_STORE_NAME,
} from "./session-snapshot-database.ts";
import {
  clearStoredChatSnapshots,
  deleteStoredChatSnapshot,
} from "./session-snapshot-invalidation.ts";
import { SessionSnapshotStore } from "./session-snapshot-store.ts";

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
const sessionKey = `scope:${JSON.stringify([scope.gatewayScope, scope.recoveryScope])}\u0000agent:main:cedar`;

describe("persistent sidebar projections", () => {
  const stores: SessionSnapshotStore[] = [];
  function createStore() {
    const store = new SessionSnapshotStore();
    store.connect();
    stores.push(store);
    return store;
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

  it("retires the legacy roster database when admitting the unified cache", async () => {
    const legacy = await requestResult(indexedDB.open("openclaw-session-roster", 1));
    legacy.close();
    const store = createStore();
    await store.writeSidebar(key(scope), model, validate);
    expect((await indexedDB.databases()).map((database) => database.name)).not.toContain(
      "openclaw-session-roster",
    );
    expect(await store.readSidebar(key(scope), validate)).toEqual(model);
  });

  it("restores the settled row order before a connection and isolates gateway, account and profile", async () => {
    const writer = createStore();
    const captured = { rows: [...model.rows] };
    const writing = writer.writeSidebar(key(scope), captured, validate);
    captured.rows.reverse();
    expect(await writing).toBe(true);
    const reader = createStore();
    expect(await reader.readSidebar(key(scope), validate)).toEqual(model);
    for (const other of [
      { ...scope, gatewayScope: "wss://other.example" },
      { ...scope, recoveryScope: "account-b" },
      { ...scope, profileId: "profile-b" },
    ]) {
      expect(await reader.readSidebar(key(other), validate)).toBeNull();
      await writer.writeSidebar(key(other), model, validate);
    }
    await writer.delete(key(scope));
    expect(await reader.readSidebar(key(scope), validate)).toBeNull();
    expect(await reader.readSidebar(key({ ...scope, profileId: "profile-b" }), validate)).toEqual(
      model,
    );
  });

  it("shares account and global invalidation with the transcript cache", async () => {
    const store = createStore();
    const otherProfile = { ...scope, profileId: "profile-b" };
    const otherAccount = { ...scope, recoveryScope: "account-b" };
    for (const current of [scope, otherProfile, otherAccount]) {
      await store.writeSidebar(key(current), model, validate);
    }
    await clearStoredChatSnapshots(
      `scope:${JSON.stringify([scope.gatewayScope, scope.recoveryScope])}\u0000`,
    );
    expect(await store.readSidebar(key(scope), validate)).toBeNull();
    expect(await store.readSidebar(key(otherProfile), validate)).toBeNull();
    expect(await store.readSidebar(key(otherAccount), validate)).toEqual(model);
    await clearStoredChatSnapshots();
    expect(await store.readSidebar(key(otherAccount), validate)).toBeNull();
  });

  it("prunes oldest records by count, UTF-8 bytes, and age", async () => {
    let now = 1;
    vi.spyOn(Date, "now").mockImplementation(() => now++);
    const store = createStore();
    for (let index = 0; index < 9; index += 1) {
      await store.writeSidebar(key({ ...scope, profileId: `profile-${index}` }), model, validate);
    }
    expect(await store.readSidebar(key({ ...scope, profileId: "profile-0" }), validate)).toBeNull();
    expect(await store.readSidebar(key({ ...scope, profileId: "profile-1" }), validate)).toEqual(
      model,
    );
    await clearStoredChatSnapshots();
    const large = { rows: ["🦞".repeat(70_000)] };
    await store.writeSidebar(key(scope), large, validate);
    await store.writeSidebar(key({ ...scope, profileId: "newer" }), large, validate);
    expect(await store.readSidebar(key(scope), validate)).toBeNull();
    expect(await store.readSidebar(key({ ...scope, profileId: "newer" }), validate)).toEqual(large);
    await store.writeSidebar(key(scope), { rows: ["🦞".repeat(140_000)] }, validate);
    expect(await store.readSidebar(key(scope), validate)).toBeNull();
    now += 31 * 24 * 60 * 60 * 1000;
    expect(await store.readSidebar(key({ ...scope, profileId: "newer" }), validate)).toBeNull();
  });

  it.each([undefined, "cache-eviction"] as const)(
    "removes only the requested transcript and applies %s sidebar invalidation",
    async (reason) => {
      const store = createStore();
      const otherProfile = { ...scope, profileId: "profile-b" };
      const otherAccount = { ...scope, recoveryScope: "account-b" };
      for (const current of [scope, otherProfile, otherAccount]) {
        await store.writeSidebar(key(current), model, validate);
      }
      const transcripts = new SessionSnapshotStore();
      const snapshot = {
        messages: ["synthetic"],
        pagination: { hasMore: false as const },
        sessionId: "cedar",
      };
      const retained = `${sessionKey}-retained`;
      transcripts.write(sessionKey, snapshot);
      transcripts.write(retained, snapshot);
      await transcripts.flush();
      await deleteStoredChatSnapshot(sessionKey, reason);
      expect(await transcripts.read(sessionKey)).toBeNull();
      expect(await transcripts.read(retained)).toEqual(snapshot);
      const expected = reason === "cache-eviction" ? model : null;
      expect(await store.readSidebar(key(scope), validate)).toEqual(expected);
      expect(await store.readSidebar(key(otherProfile), validate)).toEqual(expected);
      expect(await store.readSidebar(key(otherAccount), validate)).toEqual(model);
    },
  );

  it.each(["profile", "account", "session", "cache-eviction", "all"] as const)(
    "fences queued writes and already-read values across %s invalidation",
    async (kind) => {
      const store = createStore();
      const invalidate = () =>
        kind === "profile"
          ? store.delete(key(scope))
          : kind === "session" || kind === "cache-eviction"
            ? deleteStoredChatSnapshot(sessionKey, kind === "cache-eviction" ? kind : undefined)
            : clearStoredChatSnapshots(
                kind === "account"
                  ? `scope:${JSON.stringify([scope.gatewayScope, scope.recoveryScope])}\u0000`
                  : undefined,
              );
      await Promise.all([store.writeSidebar(key(scope), model, validate), invalidate()]);
      const expected = kind === "cache-eviction" ? model : null;
      expect(await store.readSidebar(key(scope), validate)).toEqual(expected);
      await store.writeSidebar(key(scope), model, validate);
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
      expect(await store.readSidebar(key(scope), validate)).toEqual(expected);
      expect(invalidation).toBeDefined();
      await invalidation;
      expect(await createStore().readSidebar(key(scope), validate)).toEqual(expected);
    },
  );

  it("resets a mismatched stored projection and rejects unadmitted display data", async () => {
    const store = createStore();
    await store.writeSidebar(key(scope), model, validate);
    const database = await openSessionSnapshotDatabase();
    if (!database) {
      throw new Error("expected snapshot database");
    }
    const transaction = database.transaction(SIDEBAR_SNAPSHOT_STORE_NAME, "readwrite");
    const objectStore = transaction.objectStore(SIDEBAR_SNAPSHOT_STORE_NAME);
    const keys = await requestResult(objectStore.getAllKeys());
    objectStore.put({ sessionKey: keys[0], projectionVersion: 99, savedAt: 1, model });
    await transactionComplete(transaction);
    database.close();
    expect(await store.readSidebar(key(scope), validate)).toBeNull();
    const unadmitted = { ...model, token: "synthetic-disallowed-field" };
    await store.writeSidebar(key(scope), unadmitted, validate);
    expect(await store.readSidebar(key(scope), validate)).toBeNull();
  });

  it("treats unavailable persistence as a cache miss and stops work after disconnect", async () => {
    const store = createStore();
    const writing = store.writeSidebar(key(scope), model, validate);
    store.disconnect();
    store.connect();
    await store.whenIdle();
    await writing;
    expect(await createStore().readSidebar(key(scope), validate)).toBeNull();
    await store.writeSidebar(key(scope), model, validate);
    expect(await store.readSidebar(key(scope), validate)).toEqual(model);
    vi.stubGlobal("indexedDB", undefined);
    const unavailable = createStore();
    await expect(unavailable.writeSidebar(key(scope), model, validate)).resolves.toBe(false);
    expect(await unavailable.readSidebar(key(scope), validate)).toBeNull();
  });
});
