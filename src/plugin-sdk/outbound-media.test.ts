import { setImmediate } from "node:timers/promises";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import type {
  HostedOutboundMediaChunkRecord as MediaChunk,
  HostedOutboundMediaMetaRecord as MediaMetadata,
} from "./outbound-media.js";
import type { PluginStateKeyedStore } from "./plugin-state-runtime.js";
import {
  createPluginStateKeyedStoreForTests,
  createPluginStateSyncKeyedStoreForTests,
  executeSqliteQuerySync,
  getNodeSqliteKysely,
  openOpenClawStateDatabase,
  resetPluginStateStoreForTests,
  type OpenClawStateKyselyDatabaseForTests,
} from "./plugin-state-test-runtime.js";
const MEDIA_ID = "abc123abc123abc123abc123";
const FIRST_ID = "111111111111111111111111";
const SECOND_ID = "222222222222222222222222";
const loadWebMediaMock = vi.hoisted(() => vi.fn());
type OutboundMediaModule = typeof import("./outbound-media.js");
let createHostedOutboundMediaStore: OutboundMediaModule["createHostedOutboundMediaStore"];
type MediaOptions = Parameters<OutboundMediaModule["createHostedOutboundMediaStore"]>[0];
function createMediaStore(
  options: Pick<MediaOptions, "metadataStore" | "chunkStore"> & Partial<MediaOptions>,
) {
  return createHostedOutboundMediaStore({
    ttlMs: 120_000,
    resolveExpiresAtMs: () => Date.now() + 120_000,
    createId: () => MEDIA_ID,
    createToken: () => "token123",
    rawChunkBytes: 4,
    maxEntries: 10,
    maxChunkRows: 100,
    ...options,
  });
}

function stateStore<T>(namespace: string, maxEntries: number, rejectNew = false) {
  return createPluginStateKeyedStoreForTests<T>("fixture-plugin", {
    namespace,
    maxEntries,
    ...(rejectNew ? { overflowPolicy: "reject-new" as const } : {}),
  });
}

function delayLookup(store: PluginStateKeyedStore<MediaMetadata>) {
  const started = createDeferred();
  const released = createDeferred();
  const lookup = store.lookup.bind(store);
  vi.spyOn(store, "lookup").mockImplementationOnce(async (key) => {
    const result = await lookup(key);
    started.resolve();
    await released.promise;
    return result;
  });
  return { lookupStarted: started.promise, releaseLookup: released.resolve };
}

function createStores(namespace: string, entries = 10, chunks = 100, rejectNew = false) {
  return {
    metadataStore: stateStore<MediaMetadata>(namespace, entries, rejectNew),
    chunkStore: stateStore<MediaChunk>(`${namespace}-chunks`, chunks, rejectNew),
  };
}

function twoIds(ids = [FIRST_ID, SECOND_ID]) {
  let count = 0;
  return () => ids[count++] ?? "ffffffffffffffffffffffff";
}

function imageMedia(bytes = "image-bytes") {
  return { buffer: Buffer.from(bytes), kind: "image", contentType: "image/png" };
}

function prepare(
  store: ReturnType<OutboundMediaModule["createHostedOutboundMediaStore"]>,
  mediaUrl = "https://example.com/photo.png",
  overrides: Partial<Parameters<typeof store.prepareUrl>[0]> = {},
) {
  return store.prepareUrl({
    mediaUrl,
    routePath: "/hook/media/",
    publicBaseUrl: "https://gateway.example.com",
    maxBytes: 1024,
    ...overrides,
  });
}

function createClockedStateStore<T>(
  options: Parameters<typeof createPluginStateSyncKeyedStoreForTests>[1],
): PluginStateKeyedStore<T> {
  // Native workers have a real clock; retention fixtures need SQLite and media on one fake clock.
  const store = createPluginStateSyncKeyedStoreForTests<T>("fixture-plugin", options);
  return {
    register: async (...args) => store.register(...args),
    registerIfAbsent: async (...args) => store.registerIfAbsent(...args),
    lookup: async (...args) => store.lookup(...args),
    consume: async (...args) => store.consume(...args),
    delete: async (key) => store.delete(key),
    entries: async () => store.entries(),
    clear: async () => store.clear(),
  };
}

function clockedStores(namespace: string) {
  const chunks = `${namespace}-chunks`;
  return {
    metadataStore: createClockedStateStore<MediaMetadata>({ namespace, maxEntries: 10 }),
    chunkStore: createClockedStateStore<MediaChunk>({ namespace: chunks, maxEntries: 100 }),
  };
}

function createStoreFixture(
  namespace = "hosted-media",
  options: Partial<MediaOptions> = {},
  backing: [number, number, boolean] = [
    options.maxEntries ?? 10,
    options.maxChunkRows ?? 100,
    options.overflowPolicy === "reject-new",
  ],
) {
  const { metadataStore, chunkStore } = createStores(namespace, ...backing);
  return {
    metadataStore,
    chunkStore,
    store: createMediaStore({
      metadataStore,
      chunkStore,
      ...options,
    }),
  };
}

beforeAll(async () => {
  const webMedia = await import("./web-media.js");
  vi.spyOn(webMedia, "loadWebMedia").mockImplementation(loadWebMediaMock);
  ({ createHostedOutboundMediaStore } = await import("./outbound-media.js"));
});
afterAll(() => vi.restoreAllMocks());

beforeEach(() => {
  resetPluginStateStoreForTests();
  loadWebMediaMock.mockReset().mockResolvedValueOnce(imageMedia());
  vi.useRealTimers();
});

describe("createHostedOutboundMediaStore", () => {
  it("releases a failed read acquisition so deletion can reclaim its rows", async () => {
    const { metadataStore, chunkStore, store } = createStoreFixture("failed-reader-media");
    await prepare(store);
    const failure = new Error("metadata read failed");
    vi.spyOn(metadataStore, "lookup").mockRejectedValueOnce(failure);

    await expect(store.read(MEDIA_ID)).rejects.toBe(failure);
    await store.delete(MEDIA_ID);

    expect(await metadataStore.entries()).toEqual([]);
    expect(await chunkStore.entries()).toEqual([]);
  });

  it("stores hosted media chunks and reads them back through point reads", async () => {
    loadWebMediaMock
      .mockReset()
      .mockResolvedValueOnce({ ...imageMedia(), fileName: "floor-plan.png" });
    const { metadataStore, chunkStore } = createStores("point-read-media");
    const store = createMediaStore({
      metadataStore,
      chunkStore: { ...chunkStore, lookupMany: undefined },
    });

    const url = await prepare(store);
    const entry = await store.read(MEDIA_ID);

    expect(url).toBe(
      "https://gateway.example.com/hook/media/abc123abc123abc123abc123?token=token123",
    );
    expect(entry?.metadata).toMatchObject({
      routePath: "/hook/media/",
      token: "token123",
      contentType: "image/png",
      fileName: "floor-plan.png",
      byteLength: Buffer.byteLength("image-bytes"),
    });
    expect(entry?.buffer.toString("utf8")).toBe("image-bytes");
  });

  it("validates the loaded bytes before persisting a capability", async () => {
    const media = {
      buffer: Buffer.from("active-bytes"),
      kind: undefined,
      contentType: "text/html",
      fileName: "active.html",
    };
    loadWebMediaMock.mockReset().mockResolvedValueOnce(media);
    const { store } = createStoreFixture("hosted-media-validation");
    const validateBeforePersist = vi.fn(() => {
      throw new Error("active content rejected");
    });

    await expect(
      prepare(store, "https://example.com/active.html", { validateBeforePersist }),
    ).rejects.toThrow("active content rejected");

    expect(validateBeforePersist).toHaveBeenCalledWith(
      expect.objectContaining({
        buffer: media.buffer,
        contentType: "text/html",
        fileName: "active.html",
      }),
    );
    await expect(store.readMetadata(MEDIA_ID)).resolves.toBeNull();
  });

  it.each(["metadata", "complete"] as const)(
    "serializes deletion against an admitted %s read",
    async (kind) => {
      const { metadataStore, chunkStore, store } = createStoreFixture(`pending-${kind}-media`);
      await prepare(store);
      const { lookupStarted, releaseLookup } = delayLookup(metadataStore);
      const pending = kind === "metadata" ? store.readMetadata(MEDIA_ID) : store.read(MEDIA_ID);
      await lookupStarted;
      await store.delete(MEDIA_ID);
      if (kind === "complete") {
        expect(await metadataStore.entries()).toHaveLength(1);
        expect(await chunkStore.entries()).toHaveLength(3);
      }
      releaseLookup();
      if (kind === "metadata") {
        await expect(pending).resolves.toBeNull();
      } else {
        await expect(pending).resolves.toMatchObject({ buffer: Buffer.from("image-bytes") });
        expect(await metadataStore.entries()).toEqual([]);
        expect(await chunkStore.entries()).toEqual([]);
      }
    },
  );

  it("reads hosted metadata without hydrating chunk rows", async () => {
    loadWebMediaMock
      .mockReset()
      .mockResolvedValueOnce({ ...imageMedia(), fileName: "floor-plan.png" });
    const { chunkStore, store } = createStoreFixture("metadata-only-media");
    expect(await prepare(store)).toBe(
      "https://gateway.example.com/hook/media/abc123abc123abc123abc123?token=token123",
    );
    const chunkLookup = vi.spyOn(chunkStore, "lookup");
    const chunkBulkLookup = vi.spyOn(chunkStore, "lookupMany");

    await expect(store.readMetadata(MEDIA_ID)).resolves.toMatchObject({
      routePath: "/hook/media/",
      token: "token123",
      contentType: "image/png",
      fileName: "floor-plan.png",
      byteLength: Buffer.byteLength("image-bytes"),
    });
    expect(chunkLookup).not.toHaveBeenCalled();
    expect(chunkBulkLookup).not.toHaveBeenCalled();
  });

  it.each([0, 100])("cleans expired rows after %s ms serving grace", async (grace) => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    const { metadataStore, chunkStore } = clockedStores("ttl-media");
    const store = createMediaStore({
      metadataStore,
      chunkStore,
      ttlMs: grace ? 120_000 : 100,
      ...(grace ? { postExpiryRetentionMs: grace } : {}),
      resolveExpiresAtMs: () => Date.now() + 100,
    });

    await prepare(store);
    const { db } = openOpenClawStateDatabase();
    const sql = getNodeSqliteKysely<OpenClawStateKyselyDatabaseForTests>(db);
    const persistedRows = sql
      .selectFrom("plugin_state_entries")
      .select("namespace")
      .select((eb) => eb("expires_at", "-", eb.ref("created_at")).as("ttlMs"))
      .where("plugin_id", "=", "fixture-plugin")
      .where("namespace", "in", ["ttl-media", "ttl-media-chunks"])
      .orderBy("namespace")
      .orderBy("entry_key");
    expect(executeSqliteQuerySync(db, persistedRows).rows).toEqual([
      { namespace: "ttl-media", ttlMs: grace ? 180_000 : 200 },
      ...Array.from({ length: 3 }, () => ({
        namespace: "ttl-media-chunks",
        ttlMs: grace ? 120_100 : 100,
      })),
    ]);
    expect(await metadataStore.entries()).toHaveLength(1);
    expect(await chunkStore.entries()).toHaveLength(3);

    vi.setSystemTime(1101);
    expect(await metadataStore.entries()).toHaveLength(1);
    expect(await chunkStore.entries()).toHaveLength(grace ? 3 : 0);
    if (grace) {
      await expect(store.readMetadata(MEDIA_ID)).resolves.toBeNull();
      await store.cleanupExpired();
      expect(await metadataStore.entries()).toHaveLength(1);
      expect(await chunkStore.entries()).toHaveLength(3);
      vi.setSystemTime(1201);
    }
    await store.cleanupExpired();
    expect(await metadataStore.entries()).toEqual([]);
    expect(await chunkStore.entries()).toEqual([]);
    // Expired chunks must be deleted, not merely hidden by the backing store.
    expect(executeSqliteQuerySync(db, persistedRows).rows).toEqual([]);
  });

  it("retains metadata until a failed chunk cleanup can be retried", async () => {
    loadWebMediaMock.mockResolvedValueOnce(imageMedia());
    const { metadataStore, chunkStore, store } = createStoreFixture("retry-delete-media");
    await prepare(store);
    const originalDelete = chunkStore.delete.bind(chunkStore);
    let deleteCalls = 0;
    vi.spyOn(chunkStore, "delete").mockImplementation(async (key) => {
      deleteCalls += 1;
      if (deleteCalls === 2) {
        throw new Error("chunk delete failed");
      }
      return await originalDelete(key);
    });

    await expect(store.delete("abc123abc123abc123abc123")).rejects.toThrow("chunk delete failed");
    expect(await metadataStore.entries()).toHaveLength(1);

    await expect(store.delete("abc123abc123abc123abc123")).resolves.toBeUndefined();
    expect(await metadataStore.entries()).toEqual([]);
    expect(await chunkStore.entries()).toEqual([]);
  });

  it("serializes explicit deletion with reject-new capacity checks", async () => {
    loadWebMediaMock.mockResolvedValue(imageMedia());
    const { chunkStore, store } = createStoreFixture("serialized-delete-media", {
      createId: twoIds(),
      rawChunkBytes: 64,
      maxEntries: 1,
      maxChunkRows: 1,
      overflowPolicy: "reject-new",
    });
    await prepare(store, "https://example.com/first.png");
    const deleteStarted = createDeferred();
    const deleteReleased = createDeferred();
    const originalDelete = chunkStore.delete.bind(chunkStore);
    vi.spyOn(chunkStore, "delete").mockImplementationOnce(async (key) => {
      deleteStarted.resolve();
      await deleteReleased.promise;
      return await originalDelete(key);
    });

    const deletion = store.delete(FIRST_ID);
    await deleteStarted.promise;
    const replacement = prepare(store, "https://example.com/second.png");
    let replacementSettled = false;
    const markSettled = () => {
      replacementSettled = true;
    };
    void replacement.then(markSettled, markSettled);
    await setImmediate();
    expect(replacementSettled).toBe(false);
    deleteReleased.resolve();

    await expect(deletion).resolves.toBeUndefined();
    await expect(replacement).resolves.toContain(SECOND_ID);
  });

  it("prunes oldest complete entries before chunk rows evict independently", async () => {
    loadWebMediaMock.mockResolvedValue(imageMedia());
    const { store } = createStoreFixture(
      "capacity-media",
      { createId: twoIds(), maxEntries: 2, maxChunkRows: 4 },
      [4, 4, true],
    );

    await prepare(store, "https://example.com/first.png");
    await prepare(store, "https://example.com/second.png");

    expect(await store.read(FIRST_ID)).toBeNull();
    expect(await store.read(SECOND_ID)).not.toBeNull();
  });

  it("deletes corrupt metadata by its stored key without revoking a live URL", async () => {
    const liveId = FIRST_ID;
    const corruptId = SECOND_ID;
    const { metadataStore, store } = createStoreFixture(
      "corrupt-capacity-media",
      { createId: () => liveId, maxEntries: 1, maxChunkRows: 1, overflowPolicy: "reject-new" },
      [2, 1, true],
    );
    loadWebMediaMock.mockReset().mockResolvedValue(imageMedia("x"));
    await prepare(store, "https://example.com/live.png");
    await metadataStore.register(`media:${corruptId}:meta`, {
      id: liveId,
      routePath: "/hook/media/",
      token: "corrupt-token",
      contentType: "image/png",
      expiresAt: Date.now() + 120_000,
      chunkCount: 0,
      byteLength: 1,
    });

    await expect(prepare(store, "https://example.com/rejected.png")).rejects.toThrow(
      "hosted outbound media capacity is full",
    );
    expect(await store.read(liveId)).not.toBeNull();
    expect(await metadataStore.lookup(`media:${corruptId}:meta`)).toBeUndefined();
  });

  it("serializes concurrent reject-new preparations without evicting live URLs", async () => {
    const ids = [FIRST_ID, SECOND_ID, "333333333333333333333333"];
    const { store } = createStoreFixture("concurrent-reject-capacity-media", {
      createId: twoIds(ids),
      maxEntries: 2,
      maxChunkRows: 2,
      overflowPolicy: "reject-new",
    });
    loadWebMediaMock.mockReset().mockResolvedValue(imageMedia("x"));

    await prepare(store, "https://example.com/existing.png");
    const results = await Promise.allSettled([
      prepare(store, "https://example.com/second.png"),
      prepare(store, "https://example.com/third.png"),
    ]);

    expect(results.map((result) => result.status).toSorted()).toEqual(["fulfilled", "rejected"]);
    expect(await store.read(ids[0] ?? "")).not.toBeNull();
    const liveNewEntries = await Promise.all(ids.slice(1).map(async (id) => await store.read(id)));
    expect(liveNewEntries.filter(Boolean)).toHaveLength(1);
  });

  it("rolls back only new chunks when reject-new backing capacity races", async () => {
    const { chunkStore, store } = createStoreFixture(
      "backing-race-media",
      { createId: twoIds(), maxEntries: 2, maxChunkRows: 3, overflowPolicy: "reject-new" },
      [2, 2, true],
    );
    loadWebMediaMock
      .mockReset()
      .mockResolvedValueOnce(imageMedia("x"))
      .mockResolvedValueOnce(imageMedia("12345"));

    await prepare(store, "https://example.com/existing.png");
    await expect(prepare(store, "https://example.com/racing.png")).rejects.toThrow(
      "reached its 2-row limit",
    );

    expect(await store.read(FIRST_ID)).not.toBeNull();
    expect(await store.read(SECOND_ID)).toBeNull();
    expect(await chunkStore.entries()).toHaveLength(1);
  });
});

describe("hosted media bulk read error order", () => {
  it("preserves early exits, cleanup, and reached errors", async () => {
    loadWebMediaMock.mockReset();
    await withOpenClawTestState({ label: "hosted-media-bulk-errors" }, async () => {
      for (const early of ["missing", "invalid-index", "invalid-bytes", "valid"]) {
        const { metadataStore, chunkStore } = createStores(`bulk-${early}`, 10, 10);
        const id = MEDIA_ID;
        const key = (index: number) => `media:${id}:chunk:${String(index).padStart(4, "0")}`;
        await metadataStore.register(`media:${id}:meta`, {
          id,
          routePath: "/media/",
          token: "synthetic-token",
          expiresAt: Date.now() + 60_000,
          chunkCount: 2,
          byteLength: 8,
        });
        if (early !== "missing") {
          await chunkStore.register(key(0), {
            id,
            index: early === "invalid-index" ? -1 : 0,
            dataBase64: Buffer.from(early === "invalid-bytes" ? "x" : "1234").toString("base64"),
          });
        }
        const { db } = openOpenClawStateDatabase();
        // Seed corruption before a keyed write receipt can cache a valid chunk.
        db.prepare(
          "INSERT INTO plugin_state_entries (plugin_id, namespace, entry_key, value_json, created_at, expires_at) VALUES (?, ?, ?, ?, ?, NULL)",
        ).run("fixture-plugin", `bulk-${early}-chunks`, key(1), "invalid JSON", Date.now());
        const store = createMediaStore({
          metadataStore,
          chunkStore,
          ttlMs: 60_000,
          resolveExpiresAtMs: () => Date.now() + 60_000,
          maxChunkRows: 10,
        });
        if (early === "valid") {
          await expect(store.read(id)).rejects.toMatchObject({
            code: "PLUGIN_STATE_CORRUPT",
            operation: "lookup",
          });
          expect(await metadataStore.entries()).toHaveLength(1);
        } else {
          await expect(store.read(id)).resolves.toBeNull();
          expect(await metadataStore.entries()).toEqual([]);
          expect(await chunkStore.entries()).toEqual([]);
        }
      }
    });
  });
});

describe("hosted outbound media retention and aggregate capacity", () => {
  it("rejects an individually oversized entry before evicting live capabilities", async () => {
    const ids = ["333333333333333333333333", "444444444444444444444444"];
    const { store } = createStoreFixture("evicting-byte-media", {
      createId: twoIds(ids),
      maxEntries: 2,
      maxChunkRows: 4,
      maxTotalBytes: 5,
      overflowPolicy: "evict-oldest",
    });
    loadWebMediaMock
      .mockReset()
      .mockResolvedValueOnce(imageMedia("abc"))
      .mockResolvedValueOnce(imageMedia("abcdef"));

    await prepare(store, "https://example.com/first.png", { maxBytes: 10 });
    await expect(
      prepare(store, "https://example.com/oversized.png", { maxBytes: 10 }),
    ).rejects.toThrow("payload exceeds aggregate byte capacity");
    expect(await store.read(ids[0] ?? "")).not.toBeNull();
    expect(await store.read(ids[1] ?? "")).toBeNull();
  });
});
