import { describe, expect, it } from "vitest";
import type {
  SessionStoreAdapter,
  SessionStoreRecord,
  SessionTranscriptChunk,
  SessionTranscriptChunkListOptions,
} from "./storage-adapter.js";
import {
  assertTranscriptChunkReadable,
  readRecentTranscriptChunkWindow,
  readTranscriptChunkWindow,
} from "./transcript-chunk-reader.js";

function chunk(seq: number, lines: unknown[]): SessionTranscriptChunk {
  return {
    chunkSeq: seq,
    transcriptPath: "/state/session.jsonl",
    contentSha256: `hash-${seq}`,
    bytes: 10 + seq,
    chunkJson: {
      version: 1,
      startLine: seq * 10 + 1,
      endLine: seq * 10 + lines.length,
      lines,
    },
  };
}

function createChunkReaderAdapter(chunks: SessionTranscriptChunk[]): SessionStoreAdapter & {
  listCalls: Array<{
    storePath: string;
    sessionKey: string;
    options?: SessionTranscriptChunkListOptions;
  }>;
} {
  return {
    kind: "memory",
    listCalls: [],
    async loadStore() {
      return {};
    },
    async readEntry() {
      return undefined;
    },
    async listEntries() {
      return { entries: [], totalCount: 0, hasMore: false };
    },
    async saveStore() {},
    async updateStore<T>(
      _storePath: string,
      mutator: (store: SessionStoreRecord) => T | Promise<T>,
    ) {
      return await mutator({});
    },
    async listTranscriptChunks(storePath, sessionKey, options) {
      this.listCalls.push({ storePath, sessionKey, ...(options ? { options } : {}) });
      const order = options?.orderBy ?? "chunkSeq_asc";
      const sorted = chunks.toSorted((left, right) =>
        order === "chunkSeq_desc" ? right.chunkSeq - left.chunkSeq : left.chunkSeq - right.chunkSeq,
      );
      const filtered = options?.transcriptPath
        ? sorted.filter((candidate) => candidate.transcriptPath === options.transcriptPath)
        : sorted;
      const offset = options?.offset ?? 0;
      const limit = options?.limit;
      const window =
        limit === undefined ? filtered.slice(offset) : filtered.slice(offset, offset + limit);
      const nextOffset =
        limit !== undefined && offset + limit < filtered.length ? offset + limit : undefined;
      return {
        chunks: window,
        totalCount: filtered.length,
        ...(limit !== undefined ? { limitApplied: limit } : {}),
        ...(offset > 0 ? { offset } : {}),
        ...(nextOffset !== undefined ? { nextOffset } : {}),
        hasMore: nextOffset !== undefined,
      };
    },
  };
}

describe("readTranscriptChunkWindow", () => {
  it("reads a bounded chunk window and flattens transcript lines", async () => {
    const adapter = createChunkReaderAdapter([
      chunk(0, [{ type: "session" }]),
      chunk(1, [{ message: { role: "user", content: "hello" } }]),
      chunk(2, [{ message: { role: "assistant", content: "hi" } }]),
    ]);

    await expect(
      readTranscriptChunkWindow({
        adapter,
        storePath: "/state/sessions.json",
        sessionKey: "agent:main:main",
        limit: 2,
      }),
    ).resolves.toMatchObject({
      totalCount: 3,
      limitApplied: 2,
      offset: 0,
      nextOffset: 2,
      hasMore: true,
      lines: [{ type: "session" }, { message: { role: "user", content: "hello" } }],
    });
    expect(adapter.listCalls[0]).toEqual({
      storePath: "/state/sessions.json",
      sessionKey: "agent:main:main",
      options: { limit: 2, offset: 0, orderBy: "chunkSeq_asc" },
    });
  });

  it("caps large read limits and preserves caller offset/order/path filters", async () => {
    const chunks = [
      chunk(0, [{ id: 0 }]),
      chunk(1, [{ id: 1 }]),
      { ...chunk(2, [{ id: 2 }]), transcriptPath: "/state/other.jsonl" },
    ];
    const adapter = createChunkReaderAdapter(chunks);

    await expect(
      readTranscriptChunkWindow({
        adapter,
        storePath: "/state/sessions.json",
        sessionKey: "agent:main:main",
        limit: 1_000,
        offset: 1,
        orderBy: "chunkSeq_desc",
        transcriptPath: "/state/session.jsonl",
      }),
    ).resolves.toMatchObject({
      totalCount: 2,
      limitApplied: 100,
      offset: 1,
      hasMore: false,
      lines: [{ id: 0 }],
    });
    expect(adapter.listCalls[0]?.options).toEqual({
      limit: 100,
      offset: 1,
      orderBy: "chunkSeq_desc",
      transcriptPath: "/state/session.jsonl",
    });
  });

  it("reads recent chunks in descending storage order but returns lines chronologically", async () => {
    const adapter = createChunkReaderAdapter([
      chunk(0, [{ id: 0 }]),
      chunk(1, [{ id: 1 }]),
      chunk(2, [{ id: 2 }]),
      chunk(3, [{ id: 3 }]),
    ]);

    await expect(
      readRecentTranscriptChunkWindow({
        adapter,
        storePath: "/state/sessions.json",
        sessionKey: "agent:main:main",
        limit: 2,
      }),
    ).resolves.toMatchObject({
      totalCount: 4,
      limitApplied: 2,
      offset: 0,
      nextOffset: 2,
      hasMore: true,
      chunks: [expect.objectContaining({ chunkSeq: 2 }), expect.objectContaining({ chunkSeq: 3 })],
      lines: [{ id: 2 }, { id: 3 }],
    });
    expect(adapter.listCalls[0]?.options).toEqual({
      limit: 2,
      offset: 0,
      orderBy: "chunkSeq_desc",
    });
  });

  it("fails closed when the adapter has no transcript chunk read method", () => {
    const adapter: SessionStoreAdapter = {
      kind: "json",
      async loadStore() {
        return {};
      },
      async readEntry() {
        return undefined;
      },
      async listEntries() {
        return { entries: [], totalCount: 0, hasMore: false };
      },
      async saveStore() {},
      async updateStore<T>(
        _storePath: string,
        mutator: (store: SessionStoreRecord) => T | Promise<T>,
      ) {
        return await mutator({});
      },
    };

    expect(() => assertTranscriptChunkReadable(adapter)).toThrow(
      'Session store adapter "json" does not support transcript chunk reads',
    );
  });
});
