import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withTempDir } from "../../test-helpers/temp-dir.js";
import {
  collectSessionTurnsFromTranscriptChunks,
  collectSessionTurnsFromTranscriptJsonl,
  migrateTranscriptJsonlSessionTurnsToAdapter,
  SessionTurnMigrationError,
  type SessionTurnMigrationCheckpoint,
} from "./session-turn-migration.js";
import type {
  SessionStoreAdapter,
  SessionStoreRecord,
  SessionTurnRecord,
  SessionTurnWriteOptions,
} from "./storage-adapter.js";

function transcriptLine(value: unknown): string {
  return JSON.stringify(value);
}

async function writeTranscript(filePath: string, lines: string[]) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${lines.join("\n")}\n`, "utf8");
}

function createSessionTurnMemoryAdapter(): SessionStoreAdapter & {
  turns: SessionTurnRecord[];
  turnWrites: Array<{
    storePath: string;
    sessionKey: string;
    turns: SessionTurnRecord[];
    options?: SessionTurnWriteOptions;
  }>;
} {
  return {
    kind: "memory",
    turns: [],
    turnWrites: [],
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
    async writeSessionTurns(storePath, sessionKey, turns, options) {
      for (const turn of turns) {
        const existingIndex = this.turns.findIndex(
          (candidate) => candidate.turnSeq === turn.turnSeq,
        );
        if (existingIndex >= 0) {
          this.turns[existingIndex] = structuredClone(turn) as SessionTurnRecord;
        } else {
          this.turns.push(structuredClone(turn) as SessionTurnRecord);
        }
      }
      this.turnWrites.push({
        storePath,
        sessionKey,
        turns: structuredClone(turns) as SessionTurnRecord[],
        ...(options ? { options } : {}),
      });
    },
    async listSessionTurns(_storePath, _sessionKey, options) {
      const sorted = this.turns.toSorted((left, right) =>
        options?.orderBy === "turnSeq_desc"
          ? right.turnSeq - left.turnSeq
          : left.turnSeq - right.turnSeq,
      );
      const offset = options?.offset ?? 0;
      const limit = options?.limit;
      const window =
        limit === undefined ? sorted.slice(offset) : sorted.slice(offset, offset + limit);
      const nextOffset =
        limit !== undefined && offset + limit < sorted.length ? offset + limit : undefined;
      return {
        turns: structuredClone(window) as SessionTurnRecord[],
        totalCount: sorted.length,
        ...(limit !== undefined ? { limitApplied: limit } : {}),
        ...(offset > 0 ? { offset } : {}),
        ...(nextOffset !== undefined ? { nextOffset } : {}),
        hasMore: nextOffset !== undefined,
      };
    },
  };
}

function createSessionTurnWriteOnlyMemoryAdapter(): SessionStoreAdapter & {
  turnWrites: SessionTurnRecord[][];
} {
  return {
    kind: "memory",
    turnWrites: [],
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
    async writeSessionTurns(_storePath, _sessionKey, turns) {
      this.turnWrites.push(structuredClone(turns) as SessionTurnRecord[]);
    },
  };
}

describe("session turn migration", () => {
  it("extracts ordered message turns from migrated transcript chunks without duplicating content", () => {
    const collected = collectSessionTurnsFromTranscriptChunks({
      storePath: "/state/sessions.json",
      sessionKey: "agent:main:main",
      transcriptPath: "/state/transcripts/session.jsonl",
      sourceTranscriptSha256: "a".repeat(64),
      chunks: [
        {
          chunkSeq: 0,
          transcriptPath: "/state/transcripts/session.jsonl",
          contentSha256: "b".repeat(64),
          bytes: 500,
          chunkJson: {
            startLine: 1,
            lines: [
              { type: "session", id: "sess-main" },
              { type: "model_change", provider: "mxapi", modelId: "MiniMax-M2.7" },
              {
                type: "message",
                id: "u1",
                parentId: "root",
                timestamp: "2026-05-22T16:52:44.766Z",
                message: { role: "user", content: [{ type: "text", text: "hello" }] },
              },
              {
                type: "message",
                id: "a1",
                parentId: "u1",
                timestamp: "2026-05-22T16:52:45.766Z",
                message: {
                  role: "assistant",
                  content: [{ type: "text", text: "world" }],
                  usage: { inputTokens: 10, output_tokens: 20 },
                },
              },
            ],
          },
        },
      ],
    });

    expect(collected.plan).toMatchObject({
      storePath: "/state/sessions.json",
      sessionKey: "agent:main:main",
      transcriptPath: "/state/transcripts/session.jsonl",
      sourceFingerprint: "a".repeat(64),
      sourceChunkCount: 1,
      sourceLineCount: 4,
      turnCount: 2,
      malformedLines: [],
      skippedLines: [],
    });
    expect(collected.turns).toEqual([
      expect.objectContaining({
        turnSeq: 0,
        role: "user",
        modelProvider: "mxapi",
        model: "MiniMax-M2.7",
        startedAt: "2026-05-22T16:52:44.766Z",
        endedAt: "2026-05-22T16:52:44.766Z",
        metadataJson: expect.objectContaining({
          source: "transcript-jsonl",
          lineNumber: 3,
          chunkSeq: 0,
          messageId: "u1",
          parentId: "root",
        }),
      }),
      expect.objectContaining({
        turnSeq: 1,
        role: "assistant",
        modelProvider: "mxapi",
        model: "MiniMax-M2.7",
        inputTokens: 10,
        outputTokens: 20,
        metadataJson: expect.objectContaining({ lineNumber: 4, messageId: "a1" }),
      }),
    ]);
    expect(JSON.stringify(collected.turns)).not.toContain("hello");
    expect(JSON.stringify(collected.turns)).not.toContain("world");
  });

  it("collects turns from JSONL and reports malformed lines without writing", async () => {
    await withTempDir({ prefix: "openclaw-session-turn-collect-" }, async (dir) => {
      const transcriptPath = path.join(dir, "session.jsonl");
      await writeTranscript(transcriptPath, [
        transcriptLine({ type: "session", id: "sess-main" }),
        "{not-json",
        transcriptLine({ type: "message", id: "u1", message: { role: "user" } }),
      ]);

      const collected = await collectSessionTurnsFromTranscriptJsonl({
        transcriptPath,
        storePath: "/state/sessions.json",
        sessionKey: "agent:main:main",
        maxLinesPerChunk: 1,
      });

      expect(collected.plan).toMatchObject({
        transcriptPath,
        sourceChunkCount: 2,
        sourceLineCount: 2,
        turnCount: 1,
        malformedLines: [expect.objectContaining({ lineNumber: 2 })],
      });
      expect(collected.turns).toHaveLength(1);
    });
  });

  it("writes session turns in resumable batches with checkpoints and read-back verification", async () => {
    await withTempDir({ prefix: "openclaw-session-turn-migrate-" }, async (dir) => {
      const transcriptPath = path.join(dir, "session.jsonl");
      await writeTranscript(transcriptPath, [
        transcriptLine({ type: "session", id: "sess-main" }),
        transcriptLine({ type: "model_change", provider: "mxapi", modelId: "MiniMax-M2.7" }),
        transcriptLine({ type: "message", id: "u1", message: { role: "user" } }),
        transcriptLine({ type: "message", id: "a1", message: { role: "assistant" } }),
        transcriptLine({ type: "message", id: "u2", message: { role: "user" } }),
      ]);
      const adapter = createSessionTurnMemoryAdapter();
      const checkpoints: SessionTurnMigrationCheckpoint[] = [];

      const result = await migrateTranscriptJsonlSessionTurnsToAdapter({
        destinationAdapter: adapter,
        storePath: "/state/sessions.json",
        sessionKey: "agent:main:main",
        transcriptPath,
        mode: "apply",
        batchSize: 2,
        maxLinesPerChunk: 2,
        agentId: "main",
        onCheckpoint(checkpoint) {
          checkpoints.push(checkpoint);
        },
      });

      expect(result).toMatchObject({
        applied: true,
        verified: true,
        verification: { requested: true, ok: true, turnsExpected: 3, turnsRead: 3, issues: [] },
        checkpoint: { nextTurnOffset: 3, turnsWritten: 3, completed: true },
      });
      expect(adapter.turnWrites.map((write) => write.turns.map((turn) => turn.turnSeq))).toEqual([
        [0, 1],
        [2],
      ]);
      expect(adapter.turnWrites[0]?.options).toEqual({ agentId: "main", skipMaintenance: true });
      expect(checkpoints.map((checkpoint) => checkpoint.nextTurnOffset)).toEqual([2, 3]);
    });
  });

  it("resumes session turn migration from a matching checkpoint", async () => {
    await withTempDir({ prefix: "openclaw-session-turn-resume-" }, async (dir) => {
      const transcriptPath = path.join(dir, "session.jsonl");
      await writeTranscript(transcriptPath, [
        transcriptLine({ type: "message", id: "u1", message: { role: "user" } }),
        transcriptLine({ type: "message", id: "a1", message: { role: "assistant" } }),
        transcriptLine({ type: "message", id: "u2", message: { role: "user" } }),
      ]);
      const dryRun = await migrateTranscriptJsonlSessionTurnsToAdapter({
        destinationAdapter: createSessionTurnMemoryAdapter(),
        storePath: "/state/sessions.json",
        sessionKey: "agent:main:main",
        transcriptPath,
        mode: "dry-run",
        batchSize: 1,
      });
      const adapter = createSessionTurnMemoryAdapter();
      const collected = await collectSessionTurnsFromTranscriptJsonl({
        transcriptPath,
        storePath: "/state/sessions.json",
        sessionKey: "agent:main:main",
      });
      adapter.turns = [structuredClone(collected.turns[0]!) as SessionTurnRecord];

      const result = await migrateTranscriptJsonlSessionTurnsToAdapter({
        destinationAdapter: adapter,
        storePath: "/state/sessions.json",
        sessionKey: "agent:main:main",
        transcriptPath,
        mode: "apply",
        batchSize: 1,
        checkpoint: {
          ...dryRun.checkpoint,
          nextTurnOffset: 1,
          turnsWritten: 1,
        },
      });

      expect(result.checkpoint).toMatchObject({ nextTurnOffset: 3, turnsWritten: 3 });
      expect(result.verification).toMatchObject({ requested: true, ok: true, turnsExpected: 3 });
      expect(adapter.turnWrites.map((write) => write.turns.map((turn) => turn.turnSeq))).toEqual([
        [1],
        [2],
      ]);
    });
  });

  it("fails closed before writing when required turn adapter methods are missing", async () => {
    await withTempDir({ prefix: "openclaw-session-turn-write-only-" }, async (dir) => {
      const transcriptPath = path.join(dir, "session.jsonl");
      await writeTranscript(transcriptPath, [
        transcriptLine({ type: "message", id: "u1", message: { role: "user" } }),
      ]);
      const writeOnly = createSessionTurnWriteOnlyMemoryAdapter();

      await expect(
        migrateTranscriptJsonlSessionTurnsToAdapter({
          destinationAdapter: writeOnly,
          storePath: "/state/sessions.json",
          sessionKey: "agent:main:main",
          transcriptPath,
          mode: "apply",
          batchSize: 1,
        }),
      ).rejects.toThrow("Destination adapter does not support session turn verification reads");
      expect(writeOnly.turnWrites).toHaveLength(0);

      await expect(
        migrateTranscriptJsonlSessionTurnsToAdapter({
          destinationAdapter: {
            ...writeOnly,
            writeSessionTurns: undefined,
          },
          storePath: "/state/sessions.json",
          sessionKey: "agent:main:main",
          transcriptPath,
          mode: "apply",
          batchSize: 1,
          verifyAfterWrite: false,
        }),
      ).rejects.toThrow("Destination adapter does not support session turn writes");
    });
  });

  it("detects destination turn verification mismatches after writing", async () => {
    await withTempDir({ prefix: "openclaw-session-turn-verify-mismatch-" }, async (dir) => {
      const transcriptPath = path.join(dir, "session.jsonl");
      await writeTranscript(transcriptPath, [
        transcriptLine({ type: "message", id: "u1", message: { role: "user" } }),
      ]);
      const adapter = createSessionTurnMemoryAdapter();
      const listSessionTurns = adapter.listSessionTurns!.bind(adapter);
      adapter.listSessionTurns = async (storePath, sessionKey, options) => {
        const result = await listSessionTurns(storePath, sessionKey, options);
        const first = result.turns[0];
        return first ? { ...result, turns: [{ ...first, role: "assistant" }] } : result;
      };

      await expect(
        migrateTranscriptJsonlSessionTurnsToAdapter({
          destinationAdapter: adapter,
          storePath: "/state/sessions.json",
          sessionKey: "agent:main:main",
          transcriptPath,
          mode: "apply",
          batchSize: 1,
        }),
      ).rejects.toBeInstanceOf(SessionTurnMigrationError);
      expect(adapter.turnWrites).toHaveLength(1);
    });
  });
});
