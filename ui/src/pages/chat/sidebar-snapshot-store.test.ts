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
import { SidebarSnapshotStore, type SidebarSnapshotScope } from "./sidebar-snapshot-store.ts";

const scope: SidebarSnapshotScope = {
  gatewayScope: "wss://sidebar.example",
  recoveryScope: "account-a",
  profileId: "profile-a",
};
const modelSchema = z.object({ rows: z.array(z.string()) }).strict();
const model = { rows: ["Agent Juniper", "Dashboard Cedar", "Calendar"] };
const sessionKey = `scope:${JSON.stringify([scope.gatewayScope, scope.recoveryScope])}\u0000agent:main:cedar`;

describe("persistent sidebar projections", () => {
  const stores: SidebarSnapshotStore<z.infer<typeof modelSchema>>[] = [];
  function createStore() {
    const store = new SidebarSnapshotStore((value) => {
      const result = modelSchema.safeParse(value);
      return result.success ? result.data : null;
    });
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
      store.dispose();
    }
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("restores the settled row order before a connection and isolates gateway, account and profile", async () => {
    const writer = createStore();
    const captured = { rows: [...model.rows] };
    const writing = writer.write(scope, captured);
    captured.rows.reverse();
    await writing;
    const reader = createStore();
    expect(await reader.read(scope)).toEqual(model);
    for (const other of [
      { ...scope, gatewayScope: "wss://other.example" },
      { ...scope, recoveryScope: "account-b" },
      { ...scope, profileId: "profile-b" },
    ]) {
      expect(await reader.read(other)).toBeNull();
      await writer.write(other, model);
    }
    await writer.invalidate(scope);
    expect(await reader.read(scope)).toBeNull();
    expect(await reader.read({ ...scope, profileId: "profile-b" })).toEqual(model);
  });

  it("shares account and global invalidation with the transcript cache", async () => {
    const store = createStore();
    const otherProfile = { ...scope, profileId: "profile-b" };
    const otherAccount = { ...scope, recoveryScope: "account-b" };
    for (const current of [scope, otherProfile, otherAccount]) {
      await store.write(current, model);
    }
    await clearStoredChatSnapshots(
      `scope:${JSON.stringify([scope.gatewayScope, scope.recoveryScope])}\u0000`,
    );
    expect(await store.read(scope)).toBeNull();
    expect(await store.read(otherProfile)).toBeNull();
    expect(await store.read(otherAccount)).toEqual(model);
    await clearStoredChatSnapshots();
    expect(await store.read(otherAccount)).toBeNull();
  });

  it("prunes oldest records by count, UTF-8 bytes, and age", async () => {
    let now = 1;
    vi.spyOn(Date, "now").mockImplementation(() => now++);
    const store = createStore();
    for (let index = 0; index < 9; index += 1) {
      await store.write({ ...scope, profileId: `profile-${index}` }, model);
    }
    expect(await store.read({ ...scope, profileId: "profile-0" })).toBeNull();
    expect(await store.read({ ...scope, profileId: "profile-1" })).toEqual(model);
    await clearStoredChatSnapshots();
    const large = { rows: ["🦞".repeat(70_000)] };
    await store.write(scope, large);
    await store.write({ ...scope, profileId: "newer" }, large);
    expect(await store.read(scope)).toBeNull();
    expect(await store.read({ ...scope, profileId: "newer" })).toEqual(large);
    await store.write(scope, { rows: ["🦞".repeat(140_000)] });
    expect(await store.read(scope)).toBeNull();
    now += 31 * 24 * 60 * 60 * 1000;
    expect(await store.read({ ...scope, profileId: "newer" })).toBeNull();
  });

  it.each([undefined, "cache-eviction"] as const)(
    "removes only the requested transcript and applies %s sidebar invalidation",
    async (reason) => {
      const store = createStore();
      const otherProfile = { ...scope, profileId: "profile-b" };
      const otherAccount = { ...scope, recoveryScope: "account-b" };
      for (const current of [scope, otherProfile, otherAccount]) {
        await store.write(current, model);
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
      expect(await store.read(scope)).toEqual(expected);
      expect(await store.read(otherProfile)).toEqual(expected);
      expect(await store.read(otherAccount)).toEqual(model);
    },
  );

  it.each(["profile", "account", "session", "cache-eviction", "all"] as const)(
    "fences queued writes and already-read values across %s invalidation",
    async (kind) => {
      const store = createStore();
      const invalidate = () =>
        kind === "profile"
          ? store.invalidate(scope)
          : kind === "session" || kind === "cache-eviction"
            ? deleteStoredChatSnapshot(sessionKey, kind === "cache-eviction" ? kind : undefined)
            : clearStoredChatSnapshots(
                kind === "account"
                  ? `scope:${JSON.stringify([scope.gatewayScope, scope.recoveryScope])}\u0000`
                  : undefined,
              );
      await Promise.all([store.write(scope, model), invalidate()]);
      const expected = kind === "cache-eviction" ? model : null;
      expect(await store.read(scope)).toEqual(expected);
      await store.write(scope, model);
      let invalidation: Promise<void> | undefined;
      const original = IDBObjectStore.prototype.getAll;
      vi.spyOn(IDBObjectStore.prototype, "getAll").mockImplementationOnce(function (
        this: IDBObjectStore,
        ...args
      ) {
        const request = original.apply(this, args);
        request.addEventListener("success", () => {
          invalidation = invalidate();
        });
        return request;
      });
      expect(await store.read(scope)).toEqual(expected);
      expect(invalidation).toBeDefined();
      await invalidation;
      expect(await createStore().read(scope)).toEqual(expected);
    },
  );

  it("resets a mismatched stored projection and rejects unadmitted display data", async () => {
    const store = createStore();
    await store.write(scope, model);
    const database = await openSessionSnapshotDatabase();
    if (!database) {
      throw new Error("expected snapshot database");
    }
    const transaction = database.transaction(SIDEBAR_SNAPSHOT_STORE_NAME, "readwrite");
    const objectStore = transaction.objectStore(SIDEBAR_SNAPSHOT_STORE_NAME);
    const keys = await requestResult(objectStore.getAllKeys());
    objectStore.put({ key: keys[0], projectionVersion: 99, savedAt: 1, model });
    await transactionComplete(transaction);
    database.close();
    expect(await store.read(scope)).toBeNull();
    const unadmitted = { ...model, token: "synthetic-disallowed-field" };
    await store.write(scope, unadmitted);
    expect(await store.read(scope)).toBeNull();
  });

  it("treats unavailable persistence as a cache miss and stops work after disposal", async () => {
    const store = createStore();
    const writing = store.write(scope, model);
    store.dispose();
    await writing;
    expect(await createStore().read(scope)).toBeNull();
    vi.stubGlobal("indexedDB", undefined);
    const unavailable = createStore();
    await expect(unavailable.write(scope, model)).resolves.toBeUndefined();
    expect(await unavailable.read(scope)).toBeNull();
  });
});
