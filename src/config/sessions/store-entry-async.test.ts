import { describe, expect, it } from "vitest";
import type { SessionStoreAdapter, SessionStoreRecord } from "./storage-adapter.js";
import { listSessionStoreRecordEntries } from "./storage-adapter.js";
import {
  patchSessionStoreEntryAsync,
  resolveSessionStoreEntryAsync,
  upsertSessionStoreEntryAsync,
} from "./store-entry-async.js";
import type { SessionEntry } from "./types.js";

type Operation = {
  name: string;
  keys?: readonly string[];
  entries?: Array<[string, SessionEntry]>;
};

function createMemoryAdapter(initial: SessionStoreRecord): SessionStoreAdapter & {
  operations: Operation[];
  store: SessionStoreRecord;
} {
  const state = {
    store: structuredClone(initial) as SessionStoreRecord,
    operations: [] as Operation[],
  };
  return {
    kind: "memory",
    get operations() {
      return state.operations;
    },
    get store() {
      return state.store;
    },
    async loadStore() {
      state.operations.push({ name: "loadStore" });
      return structuredClone(state.store) as SessionStoreRecord;
    },
    async readEntry(_storePath, sessionKey) {
      state.operations.push({ name: "readEntry", keys: [sessionKey] });
      return structuredClone(state.store[sessionKey]) as SessionEntry | undefined;
    },
    async listEntries(_storePath, options) {
      state.operations.push({ name: "listEntries", keys: options?.keys });
      return listSessionStoreRecordEntries(state.store, options);
    },
    async saveStore(_storePath, store) {
      state.operations.push({ name: "saveStore" });
      state.store = structuredClone(store) as SessionStoreRecord;
    },
    async writeEntries(_storePath, entries) {
      state.operations.push({
        name: "writeEntries",
        entries: entries.map(([key, entry]) => [key, entry]),
      });
      for (const [key, entry] of entries) {
        state.store[key] = structuredClone(entry) as SessionEntry;
      }
    },
    async deleteEntries(_storePath, keys) {
      state.operations.push({ name: "deleteEntries", keys });
      for (const key of keys) {
        delete state.store[key];
      }
    },
    async updateStore<T>(
      _storePath: string,
      mutator: (store: SessionStoreRecord) => T | Promise<T>,
    ) {
      state.operations.push({ name: "updateStore" });
      const result = await mutator(state.store);
      return result;
    },
  };
}

describe("async session store entry helpers", () => {
  it("resolves normalized and folded legacy candidates without loading the full store", async () => {
    const adapter = createMemoryAdapter({
      "agent:main:alpha": { sessionId: "old", updatedAt: 1 },
      "agent:main:Alpha": { sessionId: "new", updatedAt: 5 },
      unrelated: { sessionId: "ignored", updatedAt: 10 },
    });

    await expect(
      resolveSessionStoreEntryAsync({
        adapter,
        storePath: "/state/sessions.json",
        sessionKey: "agent:main:Alpha",
      }),
    ).resolves.toMatchObject({
      normalizedKey: "agent:main:alpha",
      existingKey: "agent:main:Alpha",
      existing: { sessionId: "new", updatedAt: 5 },
      legacyKeys: ["agent:main:Alpha"],
    });
    expect(adapter.operations.map((operation) => operation.name)).toEqual(["listEntries"]);
  });

  it("patches one entry through bounded read, writeEntries, and deleteEntries", async () => {
    const adapter = createMemoryAdapter({
      "agent:main:alpha": { sessionId: "old", updatedAt: 1, model: "gpt-old" },
      "agent:main:Alpha": { sessionId: "new", updatedAt: 5, model: "gpt-old" },
      unrelated: { sessionId: "ignored", updatedAt: 10 },
    });

    const patched = await patchSessionStoreEntryAsync({
      adapter,
      storePath: "/state/sessions.json",
      sessionKey: "agent:main:Alpha",
      update: (entry) => ({ model: `${entry.model}:patched`, updatedAt: 6 }),
    });

    expect(patched).toMatchObject({ sessionId: "new", model: "gpt-old:patched" });
    expect(patched?.updatedAt).toBeGreaterThan(5);
    expect(adapter.store).toEqual({
      "agent:main:alpha": {
        sessionId: "new",
        updatedAt: patched?.updatedAt,
        model: "gpt-old:patched",
      },
      unrelated: { sessionId: "ignored", updatedAt: 10 },
    });
    expect(adapter.operations.map((operation) => operation.name)).toEqual([
      "listEntries",
      "writeEntries",
      "deleteEntries",
    ]);
  });

  it("upserts while preserving ACP metadata from an existing entry", async () => {
    const adapter = createMemoryAdapter({
      "agent:main:session": {
        sessionId: "session",
        updatedAt: 1,
        acp: {
          backend: "claude",
          agent: "main",
          runtimeSessionName: "main",
          mode: "persistent",
          state: "idle",
          lastActivityAt: 1,
        },
      },
    });

    await upsertSessionStoreEntryAsync({
      adapter,
      storePath: "/state/sessions.json",
      sessionKey: "agent:main:session",
      entry: { sessionId: "session", updatedAt: 2 },
    });

    expect(adapter.store["agent:main:session"]).toMatchObject({
      sessionId: "session",
      updatedAt: 2,
      acp: { backend: "claude", agent: "main" },
    });
    expect(adapter.operations.map((operation) => operation.name)).toEqual([
      "listEntries",
      "writeEntries",
    ]);
  });

  it("falls back to updateStore when batch entry operations are unavailable", async () => {
    const adapter = createMemoryAdapter({
      "agent:main:session": { sessionId: "session", updatedAt: 1 },
    });
    delete adapter.writeEntries;
    delete adapter.deleteEntries;

    await patchSessionStoreEntryAsync({
      adapter,
      storePath: "/state/sessions.json",
      sessionKey: "agent:main:session",
      update: () => ({ updatedAt: 2 }),
    });

    expect(adapter.store["agent:main:session"]?.updatedAt).toBeGreaterThan(1);
    expect(adapter.operations.map((operation) => operation.name)).toEqual([
      "listEntries",
      "updateStore",
    ]);
  });
});
