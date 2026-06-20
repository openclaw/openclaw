import { describe, expect, it } from "vitest";
import type {
  SessionStoreAdapter,
  SessionStoreRecord,
  SessionTranscriptChunk,
} from "../config/sessions.js";
import {
  readRecentSessionMessagesFromTranscriptChunks,
  transcriptJsonlRecordsToMessages,
} from "./session-utils.js";

function messageRecord(
  id: string,
  role: string,
  text: string,
  parentId?: string | null,
): Record<string, unknown> {
  return {
    id,
    ...(parentId !== undefined ? { parentId } : {}),
    message: {
      role,
      content: [{ type: "text", text }],
    },
  };
}

function chunk(seq: number, lines: unknown[]): SessionTranscriptChunk {
  return {
    chunkSeq: seq,
    transcriptPath: "/state/session.jsonl",
    contentSha256: `hash-${seq}`,
    bytes: 100 + seq,
    chunkJson: {
      version: 1,
      startLine: seq * 10 + 1,
      endLine: seq * 10 + lines.length,
      lines,
    },
  };
}

function createTranscriptChunkAdapter(chunks: SessionTranscriptChunk[]): SessionStoreAdapter & {
  calls: Array<{ storePath: string; sessionKey: string; limit?: number; orderBy?: string }>;
} {
  return {
    kind: "memory",
    calls: [],
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
      this.calls.push({
        storePath,
        sessionKey,
        ...(options?.limit !== undefined ? { limit: options.limit } : {}),
        ...(options?.orderBy ? { orderBy: options.orderBy } : {}),
      });
      const sorted = chunks.toSorted((left, right) =>
        options?.orderBy === "chunkSeq_desc"
          ? right.chunkSeq - left.chunkSeq
          : left.chunkSeq - right.chunkSeq,
      );
      const offset = options?.offset ?? 0;
      const limit = options?.limit;
      const window =
        limit === undefined ? sorted.slice(offset) : sorted.slice(offset, offset + limit);
      const nextOffset =
        limit !== undefined && offset + limit < sorted.length ? offset + limit : undefined;
      return {
        chunks: window,
        totalCount: sorted.length,
        ...(limit !== undefined ? { limitApplied: limit } : {}),
        ...(nextOffset !== undefined ? { nextOffset } : {}),
        hasMore: nextOffset !== undefined,
      };
    },
  };
}

describe("transcript chunk history projection", () => {
  it("projects parsed JSONL transcript records into chat-history messages", () => {
    const messages = transcriptJsonlRecordsToMessages(
      [
        { type: "session", id: "sess-main" },
        messageRecord("1", "user", "hello", null),
        messageRecord("2", "assistant", "hi", "1"),
      ],
      { maxMessages: 10 },
    );

    expect(messages).toMatchObject([
      {
        role: "user",
        content: [{ type: "text", text: "hello" }],
        __openclaw: { id: "1", seq: 1 },
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "hi" }],
        __openclaw: { id: "2", seq: 2 },
      },
    ]);
  });

  it("reads recent transcript chunks with a bounded descending adapter query", async () => {
    const adapter = createTranscriptChunkAdapter([
      chunk(0, [{ type: "session", id: "sess-main" }, messageRecord("1", "user", "old")]),
      chunk(1, [messageRecord("2", "assistant", "middle")]),
      chunk(2, [messageRecord("3", "user", "new"), messageRecord("4", "assistant", "newer")]),
    ]);

    const messages = await readRecentSessionMessagesFromTranscriptChunks({
      adapter,
      storePath: "/state/sessions.json",
      sessionKey: "agent:main:main",
      maxMessages: 2,
      maxChunks: 2,
    });

    expect(messages).toMatchObject([
      { role: "user", content: [{ type: "text", text: "new" }] },
      { role: "assistant", content: [{ type: "text", text: "newer" }] },
    ]);
    expect(adapter.calls).toEqual([
      {
        storePath: "/state/sessions.json",
        sessionKey: "agent:main:main",
        limit: 2,
        orderBy: "chunkSeq_desc",
      },
    ]);
  });

  it("returns null rather than falling through when an adapter cannot read chunks", async () => {
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

    await expect(
      readRecentSessionMessagesFromTranscriptChunks({
        adapter,
        storePath: "/state/sessions.json",
        sessionKey: "agent:main:main",
        maxMessages: 10,
      }),
    ).resolves.toBeNull();
  });
});
