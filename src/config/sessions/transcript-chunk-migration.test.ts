import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withTempDir } from "../../test-helpers/temp-dir.js";
import type {
  SessionStoreAdapter,
  SessionStoreRecord,
  SessionTranscriptChunk,
  SessionTranscriptChunkWriteOptions,
} from "./storage-adapter.js";
import {
  collectTranscriptJsonlChunks,
  migrateTranscriptJsonlToAdapter,
  TranscriptJsonlMigrationError,
  type TranscriptJsonlMigrationCheckpoint,
} from "./transcript-chunk-migration.js";

function transcriptLine(value: unknown): string {
  return JSON.stringify(value);
}

async function writeTranscript(filePath: string, lines: string[]) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${lines.join("\n")}\n`, "utf8");
}

function createTranscriptChunkMemoryAdapter(): SessionStoreAdapter & {
  chunks: SessionTranscriptChunk[];
  chunkWrites: Array<{
    storePath: string;
    sessionKey: string;
    chunks: SessionTranscriptChunk[];
    options?: SessionTranscriptChunkWriteOptions;
  }>;
} {
  return {
    kind: "memory",
    chunks: [],
    chunkWrites: [],
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
    async writeTranscriptChunks(storePath, sessionKey, chunks, options) {
      for (const chunk of chunks) {
        const existingIndex = this.chunks.findIndex(
          (candidate) => candidate.chunkSeq === chunk.chunkSeq,
        );
        if (existingIndex >= 0) {
          this.chunks[existingIndex] = structuredClone(chunk) as SessionTranscriptChunk;
        } else {
          this.chunks.push(structuredClone(chunk) as SessionTranscriptChunk);
        }
      }
      this.chunkWrites.push({
        storePath,
        sessionKey,
        chunks: structuredClone(chunks) as SessionTranscriptChunk[],
        ...(options ? { options } : {}),
      });
    },
    async listTranscriptChunks(_storePath, _sessionKey, options) {
      const filtered = options?.transcriptPath
        ? this.chunks.filter((chunk) => chunk.transcriptPath === options.transcriptPath)
        : this.chunks;
      const sorted = filtered.toSorted((left, right) =>
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
        chunks: structuredClone(window) as SessionTranscriptChunk[],
        totalCount: sorted.length,
        ...(limit !== undefined ? { limitApplied: limit } : {}),
        ...(offset > 0 ? { offset } : {}),
        ...(nextOffset !== undefined ? { nextOffset } : {}),
        hasMore: nextOffset !== undefined,
      };
    },
  };
}

function createTranscriptChunkWriteOnlyMemoryAdapter(): SessionStoreAdapter & {
  chunkWrites: SessionTranscriptChunk[][];
} {
  return {
    kind: "memory",
    chunkWrites: [],
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
    async writeTranscriptChunks(_storePath, _sessionKey, chunks) {
      this.chunkWrites.push(structuredClone(chunks) as SessionTranscriptChunk[]);
    },
  };
}

describe("transcript JSONL chunk migration", () => {
  it("collects JSONL transcript chunks with hashes, byte counts, and line windows", async () => {
    await withTempDir({ prefix: "openclaw-transcript-chunks-" }, async (dir) => {
      const transcriptPath = path.join(dir, "session.jsonl");
      await writeTranscript(transcriptPath, [
        transcriptLine({ type: "session", id: "sess-main" }),
        transcriptLine({ type: "message", message: { role: "user", content: "hi" } }),
        transcriptLine({ type: "message", message: { role: "assistant", content: "hello" } }),
      ]);

      const collected = await collectTranscriptJsonlChunks({
        transcriptPath,
        storePath: "/state/sessions.json",
        sessionKey: "agent:main:main",
        maxLinesPerChunk: 2,
      });

      expect(collected.plan).toMatchObject({
        transcriptPath,
        storePath: "/state/sessions.json",
        sessionKey: "agent:main:main",
        totalLines: 3,
        validLines: 3,
        chunkCount: 2,
        malformedLines: [],
      });
      expect(collected.plan.totalBytes).toBeGreaterThan(0);
      expect(collected.plan.transcriptSha256).toMatch(/^[a-f0-9]{64}$/);
      expect(collected.chunks).toEqual([
        expect.objectContaining({
          chunkSeq: 0,
          transcriptPath,
          bytes: expect.any(Number),
          contentSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
          chunkJson: expect.objectContaining({ startLine: 1, endLine: 2 }),
        }),
        expect.objectContaining({
          chunkSeq: 1,
          chunkJson: expect.objectContaining({ startLine: 3, endLine: 3 }),
        }),
      ]);
    });
  });

  it("writes transcript chunks in resumable batches with checkpoints", async () => {
    await withTempDir({ prefix: "openclaw-transcript-migrate-" }, async (dir) => {
      const transcriptPath = path.join(dir, "session.jsonl");
      await writeTranscript(transcriptPath, [
        transcriptLine({ type: "session", id: "sess-main" }),
        transcriptLine({ id: "1", message: { role: "user", content: "one" } }),
        transcriptLine({ id: "2", message: { role: "assistant", content: "two" } }),
      ]);
      const adapter = createTranscriptChunkMemoryAdapter();
      const checkpoints: TranscriptJsonlMigrationCheckpoint[] = [];

      const result = await migrateTranscriptJsonlToAdapter({
        destinationAdapter: adapter,
        storePath: "/state/sessions.json",
        sessionKey: "agent:main:main",
        transcriptPath,
        mode: "apply",
        batchSize: 1,
        maxLinesPerChunk: 1,
        agentId: "main",
        onCheckpoint(checkpoint) {
          checkpoints.push(checkpoint);
        },
      });

      expect(result).toMatchObject({
        applied: true,
        verified: true,
        verification: {
          requested: true,
          ok: true,
          chunksExpected: 3,
          chunksRead: 3,
          issues: [],
        },
        checkpoint: { nextChunkSeq: 3, chunksWritten: 3, completed: true },
      });
      expect(
        adapter.chunkWrites.map((write) => write.chunks.map((chunk) => chunk.chunkSeq)),
      ).toEqual([[0], [1], [2]]);
      expect(adapter.chunkWrites[0]?.options).toEqual({ agentId: "main", skipMaintenance: true });
      expect(checkpoints.map((checkpoint) => checkpoint.nextChunkSeq)).toEqual([1, 2, 3]);
    });
  });

  it("resumes transcript chunk migration from a matching checkpoint", async () => {
    await withTempDir({ prefix: "openclaw-transcript-resume-" }, async (dir) => {
      const transcriptPath = path.join(dir, "session.jsonl");
      await writeTranscript(transcriptPath, [
        transcriptLine({ type: "session", id: "sess-main" }),
        transcriptLine({ id: "1", message: { role: "user", content: "one" } }),
        transcriptLine({ id: "2", message: { role: "assistant", content: "two" } }),
      ]);
      const dryRun = await migrateTranscriptJsonlToAdapter({
        destinationAdapter: createTranscriptChunkMemoryAdapter(),
        storePath: "/state/sessions.json",
        sessionKey: "agent:main:main",
        transcriptPath,
        mode: "dry-run",
        batchSize: 1,
        maxLinesPerChunk: 1,
      });
      const adapter = createTranscriptChunkMemoryAdapter();
      const collected = await collectTranscriptJsonlChunks({
        transcriptPath,
        storePath: "/state/sessions.json",
        sessionKey: "agent:main:main",
        maxLinesPerChunk: 1,
      });
      adapter.chunks = [structuredClone(collected.chunks[0]!) as SessionTranscriptChunk];

      const result = await migrateTranscriptJsonlToAdapter({
        destinationAdapter: adapter,
        storePath: "/state/sessions.json",
        sessionKey: "agent:main:main",
        transcriptPath,
        mode: "apply",
        batchSize: 1,
        maxLinesPerChunk: 1,
        checkpoint: {
          ...dryRun.checkpoint,
          nextChunkSeq: 1,
          chunksWritten: 1,
        },
      });

      expect(result.checkpoint).toMatchObject({ nextChunkSeq: 3, chunksWritten: 3 });
      expect(result.verification).toMatchObject({
        requested: true,
        ok: true,
        chunksExpected: 3,
        chunksRead: 3,
      });
      expect(
        adapter.chunkWrites.map((write) => write.chunks.map((chunk) => chunk.chunkSeq)),
      ).toEqual([[1], [2]]);
    });
  });

  it("reports malformed transcript lines before writing unless explicitly skipped", async () => {
    await withTempDir({ prefix: "openclaw-transcript-malformed-" }, async (dir) => {
      const transcriptPath = path.join(dir, "session.jsonl");
      await writeTranscript(transcriptPath, [
        transcriptLine({ type: "session", id: "sess-main" }),
        "{not-json",
        transcriptLine({ id: "2", message: { role: "assistant", content: "two" } }),
      ]);
      const adapter = createTranscriptChunkMemoryAdapter();

      await expect(
        migrateTranscriptJsonlToAdapter({
          destinationAdapter: adapter,
          storePath: "/state/sessions.json",
          sessionKey: "agent:main:main",
          transcriptPath,
          mode: "apply",
          batchSize: 2,
        }),
      ).rejects.toBeInstanceOf(TranscriptJsonlMigrationError);
      expect(adapter.chunkWrites).toHaveLength(0);

      await expect(
        migrateTranscriptJsonlToAdapter({
          destinationAdapter: adapter,
          storePath: "/state/sessions.json",
          sessionKey: "agent:main:main",
          transcriptPath,
          mode: "apply",
          batchSize: 2,
          skipMalformed: true,
        }),
      ).resolves.toMatchObject({
        applied: true,
        verified: true,
        plan: { malformedLines: [expect.objectContaining({ lineNumber: 2 })] },
      });
    });
  });

  it("fails closed before writing when verification is requested but the adapter cannot read chunks", async () => {
    await withTempDir({ prefix: "openclaw-transcript-write-only-" }, async (dir) => {
      const transcriptPath = path.join(dir, "session.jsonl");
      await writeTranscript(transcriptPath, [
        transcriptLine({ type: "session", id: "sess-main" }),
        transcriptLine({ id: "1", message: { role: "user", content: "one" } }),
      ]);
      const adapter = createTranscriptChunkWriteOnlyMemoryAdapter();

      await expect(
        migrateTranscriptJsonlToAdapter({
          destinationAdapter: adapter,
          storePath: "/state/sessions.json",
          sessionKey: "agent:main:main",
          transcriptPath,
          mode: "apply",
          batchSize: 1,
        }),
      ).rejects.toThrow("Destination adapter does not support transcript chunk verification reads");
      expect(adapter.chunkWrites).toHaveLength(0);

      await expect(
        migrateTranscriptJsonlToAdapter({
          destinationAdapter: adapter,
          storePath: "/state/sessions.json",
          sessionKey: "agent:main:main",
          transcriptPath,
          mode: "apply",
          batchSize: 1,
          verifyAfterWrite: false,
        }),
      ).resolves.toMatchObject({
        applied: true,
        verified: false,
        verification: { requested: false, ok: false },
      });
      expect(adapter.chunkWrites).toHaveLength(1);
    });
  });

  it("detects destination chunk verification mismatches after writing", async () => {
    await withTempDir({ prefix: "openclaw-transcript-verify-mismatch-" }, async (dir) => {
      const transcriptPath = path.join(dir, "session.jsonl");
      await writeTranscript(transcriptPath, [
        transcriptLine({ type: "session", id: "sess-main" }),
        transcriptLine({ id: "1", message: { role: "user", content: "one" } }),
      ]);
      const adapter = createTranscriptChunkMemoryAdapter();
      const listTranscriptChunks = adapter.listTranscriptChunks!.bind(adapter);
      adapter.listTranscriptChunks = async (storePath, sessionKey, options) => {
        const result = await listTranscriptChunks(storePath, sessionKey, options);
        const first = result.chunks[0];
        return first
          ? {
              ...result,
              chunks: [{ ...first, contentSha256: "tampered" }, ...result.chunks.slice(1)],
            }
          : result;
      };

      await expect(
        migrateTranscriptJsonlToAdapter({
          destinationAdapter: adapter,
          storePath: "/state/sessions.json",
          sessionKey: "agent:main:main",
          transcriptPath,
          mode: "apply",
          batchSize: 1,
          maxLinesPerChunk: 1,
        }),
      ).rejects.toThrow("Transcript JSONL migration verification failed");
      expect(adapter.chunkWrites).toHaveLength(2);
    });
  });
});
