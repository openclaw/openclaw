import { describe, expect, it } from "vitest";
import {
  listSessionStoreRecordEntries,
  type SessionStoreAdapter,
  type SessionStoreListOptions,
  type SessionStoreRecord,
  type SessionTranscriptChunk,
  type SessionTurnRecord,
} from "./storage-adapter.js";
import {
  createInMemorySessionStoreMetricsRecorder,
  instrumentSessionStoreAdapter,
} from "./store-observability.js";
import type { SessionEntry } from "./types.js";

function createMemoryAdapter(initial: SessionStoreRecord = {}): SessionStoreAdapter & {
  store: SessionStoreRecord;
} {
  const adapter: SessionStoreAdapter & {
    store: SessionStoreRecord;
  } = {
    kind: "memory",
    store: structuredClone(initial) as SessionStoreRecord,
    async loadStore(): Promise<SessionStoreRecord> {
      return structuredClone(adapter.store) as SessionStoreRecord;
    },
    async readEntry(_storePath: string, sessionKey: string): Promise<SessionEntry | undefined> {
      return structuredClone(adapter.store[sessionKey]);
    },
    async listEntries(_storePath: string, options?: SessionStoreListOptions) {
      return listSessionStoreRecordEntries(adapter.store, options);
    },
    async saveStore(_storePath: string, store: SessionStoreRecord) {
      adapter.store = structuredClone(store) as SessionStoreRecord;
    },
    async updateStore<T>(
      _storePath: string,
      mutator: (store: SessionStoreRecord) => T | Promise<T>,
    ) {
      const store = structuredClone(adapter.store) as SessionStoreRecord;
      const result = await mutator(store);
      adapter.store = store;
      return result;
    },
  };
  return adapter;
}

describe("session store observability", () => {
  it("records per-operation latency and bounded result metadata", async () => {
    const recorder = createInMemorySessionStoreMetricsRecorder();
    const times = [100, 112, 200, 205, 300, 311, 400, 417, 500, 503];
    const adapter = instrumentSessionStoreAdapter(
      createMemoryAdapter({ main: { sessionId: "sess-main", updatedAt: 1 } }),
      {
        recorder,
        nowMs: () => times.shift() ?? 999,
      },
    );

    await adapter.loadStore("/state/sessions.json");
    await adapter.readEntry("/state/sessions.json", "missing");
    await adapter.listEntries("/state/sessions.json", { limit: 1 });
    await adapter.saveStore("/state/sessions.json", {
      main: { sessionId: "sess-main", updatedAt: 2 },
      other: { sessionId: "sess-other", updatedAt: 3 },
    });
    await adapter.updateStore("/state/sessions.json", (store) => {
      store.main = { ...store.main, displayName: "updated" };
      return true;
    });

    expect(recorder.metrics).toEqual([
      expect.objectContaining({
        backend: "memory",
        operation: "loadStore",
        storePath: "/state/sessions.json",
        ok: true,
        startedAtMs: 100,
        durationMs: 12,
        entryCount: 1,
      }),
      expect.objectContaining({
        operation: "readEntry",
        ok: true,
        durationMs: 5,
        entryCount: 0,
      }),
      expect.objectContaining({
        operation: "listEntries",
        ok: true,
        durationMs: 11,
        entryCount: 1,
        totalCount: 1,
        hasMore: false,
      }),
      expect.objectContaining({
        operation: "saveStore",
        ok: true,
        durationMs: 17,
        entryCount: 2,
      }),
      expect.objectContaining({
        operation: "updateStore",
        ok: true,
        durationMs: 3,
      }),
    ]);
  });

  it("records batch, transcript chunk, and session turn operation metadata when supported", async () => {
    const recorder = createInMemorySessionStoreMetricsRecorder();
    const transcriptChunks: SessionTranscriptChunk[] = [
      {
        chunkSeq: 0,
        contentSha256: "abc",
        bytes: 10,
        chunkJson: { version: 1, startLine: 1, endLine: 1, lines: [{ type: "session" }] },
      },
      {
        chunkSeq: 1,
        contentSha256: "def",
        bytes: 15,
        chunkJson: { version: 1, startLine: 2, endLine: 2, lines: [{ type: "assistant" }] },
      },
    ];
    const sessionTurns: SessionTurnRecord[] = [
      { turnSeq: 0, role: "user", metadataJson: { source: "test" } },
      { turnSeq: 1, role: "assistant", inputTokens: 10, outputTokens: 20, metadataJson: {} },
    ];
    const times = [1_000, 1_004, 2_000, 2_009, 3_000, 3_006, 4_000, 4_007, 5_000, 5_012];
    const backingAdapter = createMemoryAdapter();
    const adapter = instrumentSessionStoreAdapter(
      {
        ...backingAdapter,
        async writeEntries(_storePath, entries) {
          for (const [key, entry] of entries) {
            backingAdapter.store[key] = structuredClone(entry) as SessionEntry;
          }
        },
        async writeTranscriptChunks() {},
        async listTranscriptChunks() {
          return {
            chunks: transcriptChunks,
            totalCount: 3,
            limitApplied: 2,
            nextOffset: 2,
            hasMore: true,
          };
        },
        async writeSessionTurns() {},
        async listSessionTurns() {
          return {
            turns: sessionTurns,
            totalCount: 4,
            limitApplied: 2,
            nextOffset: 2,
            hasMore: true,
          };
        },
      },
      { recorder, nowMs: () => times.shift() ?? 9_999 },
    );

    await adapter.writeEntries?.("/state/sessions.json", [
      ["agent:main:one", { sessionId: "sess-one", updatedAt: 1 }],
      ["agent:main:two", { sessionId: "sess-two", updatedAt: 2 }],
    ]);
    await adapter.writeTranscriptChunks?.("/state/sessions.json", "agent:main:one", [
      transcriptChunks[0]!,
      transcriptChunks[1]!,
    ]);
    await adapter.listTranscriptChunks?.("/state/sessions.json", "agent:main:one", { limit: 1 });
    await adapter.writeSessionTurns?.("/state/sessions.json", "agent:main:one", sessionTurns);
    await adapter.listSessionTurns?.("/state/sessions.json", "agent:main:one", { limit: 2 });

    expect(recorder.metrics).toEqual([
      expect.objectContaining({
        operation: "writeEntries",
        ok: true,
        durationMs: 4,
        entryCount: 2,
      }),
      expect.objectContaining({
        operation: "writeTranscriptChunks",
        ok: true,
        durationMs: 9,
        chunkCount: 2,
        byteCount: 25,
      }),
      expect.objectContaining({
        operation: "listTranscriptChunks",
        ok: true,
        durationMs: 6,
        chunkCount: 2,
        byteCount: 25,
        totalCount: 3,
        hasMore: true,
      }),
      expect.objectContaining({
        operation: "writeSessionTurns",
        ok: true,
        durationMs: 7,
        turnCount: 2,
      }),
      expect.objectContaining({
        operation: "listSessionTurns",
        ok: true,
        durationMs: 12,
        turnCount: 2,
        totalCount: 4,
        hasMore: true,
      }),
    ]);
  });

  it("records failed operations before rethrowing", async () => {
    const recorder = createInMemorySessionStoreMetricsRecorder();
    const adapter = instrumentSessionStoreAdapter(
      {
        ...createMemoryAdapter(),
        async readEntry() {
          throw new TypeError("boom");
        },
      },
      {
        recorder,
        nowMs: (() => {
          const times = [10, 19];
          return () => times.shift() ?? 19;
        })(),
      },
    );

    await expect(adapter.readEntry("/state/sessions.json", "main")).rejects.toThrow("boom");
    expect(recorder.metrics).toEqual([
      expect.objectContaining({
        operation: "readEntry",
        ok: false,
        durationMs: 9,
        errorName: "TypeError",
        errorMessage: "boom",
      }),
    ]);
  });
});
