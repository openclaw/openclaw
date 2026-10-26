import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { zstdDecompressSync } from "node:zlib";
import { afterAll, expect, it, vi } from "vitest";
import { executeSqliteQuerySync } from "../../infra/kysely-sync.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import { useSessionStoreTempDirs } from "../../test-utils/session-state-cleanup.js";
import { encodeSessionArchiveContent } from "./archive-compression.js";
import { replaceSessionEntry } from "./session-accessor.js";
import { readTranscriptArchivePageInWorker } from "./session-accessor.sqlite-archive-read.js";
import { readTranscriptArchiveRecords } from "./session-accessor.sqlite-archive-stream.js";
import { planSessionStateDeleteIfUnreferenced } from "./session-accessor.sqlite-delete-snapshot.js";
import { getSessionKysely } from "./session-accessor.sqlite-scope.js";
import { replaceTranscriptEvents } from "./session-accessor.sqlite-transcript-write.test-support.js";
import { resolveSqliteTargetFromSessionStorePath } from "./session-sqlite-target.js";

vi.mock("./session-accessor.sqlite-archive-artifact.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./session-accessor.sqlite-archive-artifact.js")>();
  return { ...actual, MAX_MATERIALIZED_ARCHIVE_BATCH_BYTES: 1024 };
});

vi.mock("./session-accessor.sqlite-archive-stream.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./session-accessor.sqlite-archive-stream.js")>();
  return { ...actual, MAX_TASK_ARCHIVE_RECORD_BYTES: 768 };
});

const sessionDirs = useSessionStoreTempDirs(afterAll, "openclaw-archive-byte-limit-");
async function* buffers(...parts: string[]) {
  yield* parts.map((part) => Buffer.from(part));
}
async function records(source: AsyncIterable<Uint8Array>, limit?: number) {
  const collected: string[] = [];
  for await (const record of readTranscriptArchiveRecords(source, limit)) {
    collected.push(record);
  }
  return collected;
}

it.each([
  "aggregate blobs",
  "decoded stream",
  "one record",
  "valid identity",
  "valid compressed",
] as const)("enforces archive page byte limits for %s", async (kind) => {
  const tempDir = sessionDirs.make();
  const env = { OPENCLAW_STATE_DIR: tempDir };
  const databasePath = path.join(tempDir, "bounded.sqlite");
  const options = { agentId: "main", env, path: databasePath };
  const database = openOpenClawAgentDatabase(options);
  const sessionKey = "agent:main:bounded-archive";
  const valid = kind === "valid identity" || kind === "valid compressed";
  const rows = Array.from({ length: kind === "aggregate blobs" ? 2 : 1 }, (_, index) => {
    const sessionId = `bounded-${index}`;
    const message = {
      role: "assistant",
      content: "x".repeat(valid ? 600 : kind === "one record" ? 800 : 1200),
      __openclaw: { runId: "bounded-run" },
    };
    const content = [
      JSON.stringify({ type: "session", id: sessionId }),
      JSON.stringify({ type: "message", message }),
    ].join("\n");
    const encoded =
      kind === "decoded stream" || kind === "valid compressed"
        ? encodeSessionArchiveContent(content)
        : {
            bytes: kind === "aggregate blobs" ? Buffer.alloc(600) : Buffer.from(content),
            suffix: "",
          };
    return {
      session_id: sessionId,
      session_key: sessionKey,
      generation: "generation",
      reason: "deleted" as const,
      encoding: encoded.suffix ? ("zstd" as const) : ("identity" as const),
      archive_blob: encoded.bytes,
      // Invalid encoded cases must hit metadata sizing before hash or JSON validation.
      archive_sha256:
        kind === "aggregate blobs"
          ? "0".repeat(64)
          : createHash("sha256").update(encoded.bytes).digest("hex"),
      archive_name: `${sessionId}.jsonl${encoded.suffix}`,
      created_at: index,
    };
  });
  runOpenClawAgentWriteTransaction(() => {
    executeSqliteQuerySync(
      database.db,
      getSessionKysely(database.db).insertInto("session_transcript_archives").values(rows),
    );
  }, options);
  const read = readTranscriptArchivePageInWorker(
    {
      agentId: "main",
      logicalAgentId: "main",
      databasePath,
      sessionKey,
      runId: "bounded-run",
      limit: 1,
      maxBytes: 4096,
    },
    env,
  );
  if (valid) {
    await expect(read).resolves.toMatchObject({
      entries: [{ event: { message: { content: "x".repeat(600) } } }],
      totalMessages: 1,
    });
    return;
  }
  await expect(read).rejects.toThrow(
    kind === "one record"
      ? "Archived transcript is unavailable because a record exceeds the task-history read capacity"
      : kind === "decoded stream"
        ? "Archived transcript exceeds the bounded read size"
        : "Archived transcript candidates exceed the bounded read size",
  );
});

it("bounds each framed record before reading more input and excludes its final newline", async () => {
  for (const parts of [
    ['{"x":', '"xx"}'],
    ['{"x":"', "xxxx"],
  ]) {
    async function* chunks() {
      yield* buffers(...parts);
      throw new Error("Read beyond the record capacity");
    }
    await expect(readTranscriptArchiveRecords(chunks(), 8).next()).rejects.toThrow(
      "record exceeds the task-history read capacity",
    );
  }
  await expect(records(buffers('{\n"x":0', "}\n{}"), 8)).resolves.toEqual(['{\n"x":0}', "{}"]);
  await expect(readTranscriptArchiveRecords(buffers('{"x":"xx"}')).next()).resolves.toMatchObject({
    value: '{"x":"xx"}',
    done: false,
  });
});

it("decodes complete records without copying their bytes or retaining mutable input", async () => {
  const text = JSON.stringify({ value: "Archive 🦞" });
  const input = Buffer.from(`padding${text}\n${text}`);
  const source = new Uint8Array(input.buffer, input.byteOffset + 7, input.byteLength - 7);
  const concat = vi.spyOn(Buffer, "concat");
  try {
    async function* chunks() {
      yield source;
    }
    const result = await records(chunks());
    expect(concat).not.toHaveBeenCalled();
    source.fill(0);
    expect(result).toEqual([text, text]);
  } finally {
    concat.mockRestore();
  }
});

it("frames quoted controls and invalid raw newlines across chunk boundaries", async () => {
  const quoted = JSON.stringify({ value: 'braces {} [], slash \\, quote ", unicode 🦞' });
  const input = Buffer.from(`${quoted}\n{"x":"raw\nnewline"}\n{}\n`);
  for (const size of [1, 17, input.byteLength]) {
    async function* chunks() {
      for (let offset = 0; offset < input.byteLength; offset += size) {
        yield input.subarray(offset, offset + size);
      }
    }
    await expect(records(chunks())).resolves.toEqual([quoted, '{"x":"raw', 'newline"}', "{}"]);
  }
});

it.each([false, true])(
  "materializes without flushing disposable stages (overflow=%s)",
  async (overflow) => {
    const tempDir = sessionDirs.make();
    const storePath = path.join(tempDir, "agents", "main", "sessions", "sessions.json");
    const sessionId = "archive-output-overflow";
    const sessionKey = "agent:main:archive-output-overflow";
    await replaceSessionEntry({ sessionKey, storePath }, { sessionId, updatedAt: Date.now() });
    const events = [
      {
        type: "session",
        id: sessionId,
        content: overflow ? randomBytes(4096).toString("base64") : "Archive 🦞\n",
      },
    ];
    await replaceTranscriptEvents({ sessionKey, sessionId, storePath }, events);

    const target = resolveSqliteTargetFromSessionStorePath(storePath);
    if (!target.path) {
      throw new Error("expected SQLite target path");
    }
    const database = openOpenClawAgentDatabase({
      agentId: target.agentId ?? "main",
      path: target.path,
    });
    const plan = planSessionStateDeleteIfUnreferenced({
      archiveDirectory: path.dirname(storePath),
      database,
      referencedSessionIds: new Set(),
      sessionId,
    });
    if (!plan) {
      throw new Error("expected archive plan");
    }
    closeOpenClawAgentDatabasesForTest();
    const { materializeTranscriptArchiveInWorker } =
      await import("./session-accessor.sqlite-archive.worker.js");

    using sync = vi.spyOn(fs, "fsyncSync");
    if (overflow) {
      await expect(materializeTranscriptArchiveInWorker(plan)).rejects.toThrow(
        "Archive exceeds 1024 bytes during encoding",
      );
    } else {
      const { archive } = await materializeTranscriptArchiveInWorker(plan);
      expect(archive?.encoding).toBe("zstd");
      expect(zstdDecompressSync(Buffer.from(archive!.bytes)).toString("utf8")).toBe(
        `${JSON.stringify(events[0])}\n`,
      );
    }
    expect(sync).not.toHaveBeenCalled();
    expect(
      fs
        .readdirSync(path.dirname(storePath))
        .filter((entry) => entry.includes(".stage") || entry.includes("jsonl-stage")),
    ).toEqual([]);
  },
);
