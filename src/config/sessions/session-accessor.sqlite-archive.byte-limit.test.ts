import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { executeSqliteQuerySync } from "../../infra/kysely-sync.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import { encodeSessionArchiveContent } from "./archive-compression.js";
import { replaceSessionEntry } from "./session-accessor.js";
import { readTranscriptArchivePageInWorker } from "./session-accessor.sqlite-archive-read.js";
import { readTranscriptArchiveRecords } from "./session-accessor.sqlite-archive-stream.js";
import { planSessionStateDeleteIfUnreferenced } from "./session-accessor.sqlite-lifecycle-state.js";
import { getSessionKysely } from "./session-accessor.sqlite-scope.js";
import { replaceTranscriptEvents } from "./session-accessor.sqlite-transcript-write.js";
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

describe("SQLite transcript archive byte limit", () => {
  let tempDir: string;
  let storePath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-archive-byte-limit-"));
    storePath = path.join(tempDir, "agents", "main", "sessions", "sessions.json");
  });

  afterEach(() => {
    closeOpenClawAgentDatabasesForTest();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it.each([
    "one blob",
    "aggregate blobs",
    "decoded stream",
    "one record",
    "valid identity",
    "valid compressed",
  ] as const)("enforces archive page byte limits for %s", async (kind) => {
    const env = { OPENCLAW_STATE_DIR: tempDir };
    const databasePath = path.join(tempDir, "bounded.sqlite");
    const options = { agentId: "main", env, path: databasePath };
    const database = openOpenClawAgentDatabase(options);
    const sessionKey = "agent:main:bounded-archive";
    const valid = kind === "valid identity" || kind === "valid compressed";
    const rows = Array.from({ length: kind === "aggregate blobs" ? 2 : 1 }, (_, index) => {
      const sessionId = `bounded-${index}`;
      const content = [
        JSON.stringify({ type: "session", id: sessionId }),
        JSON.stringify({
          type: "message",
          message: {
            role: "assistant",
            content: "x".repeat(valid ? 600 : kind === "one record" ? 800 : 1200),
            __openclaw: { runId: "bounded-run" },
          },
        }),
      ].join("\n");
      const encoded =
        kind === "decoded stream" || kind === "valid compressed"
          ? encodeSessionArchiveContent(content)
          : {
              bytes:
                kind === "valid identity" || kind === "one record"
                  ? Buffer.from(content)
                  : Buffer.alloc(kind === "one blob" ? 1025 : 600),
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
          kind === "decoded stream" || kind === "one record" || valid
            ? createHash("sha256").update(encoded.bytes).digest("hex")
            : "0".repeat(64),
        archive_name: `${sessionId}.jsonl${encoded.suffix}`,
        created_at: index,
        published_at: null,
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
    async function* chunks() {
      yield Buffer.from('{"x":');
      yield Buffer.from('"xx"}');
      throw new Error("Read beyond the record capacity");
    }
    await expect(readTranscriptArchiveRecords(chunks(), 8).next()).rejects.toThrow(
      "record exceeds the task-history read capacity",
    );
    async function* exact() {
      yield Buffer.from('{\n"x":0');
      yield Buffer.from("}\n{}");
    }
    const records = [];
    for await (const record of readTranscriptArchiveRecords(exact(), 8)) {
      records.push(record.toString("utf8"));
    }
    expect(records).toEqual(['{\n"x":0}', "{}"]);
    async function* uncapped() {
      yield Buffer.from('{"x":"xx"}');
    }
    await expect(readTranscriptArchiveRecords(uncapped()).next()).resolves.toMatchObject({
      value: Buffer.from('{"x":"xx"}'),
      done: false,
    });
  });

  it("aborts encoded output at the cap and removes staging files", async () => {
    const sessionId = "archive-output-overflow";
    const sessionKey = "agent:main:archive-output-overflow";
    await replaceSessionEntry({ sessionKey, storePath }, { sessionId, updatedAt: Date.now() });
    await replaceTranscriptEvents({ sessionKey, sessionId, storePath }, [
      {
        type: "session",
        id: sessionId,
        content: randomBytes(4096).toString("base64"),
      },
    ]);

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

    await expect(materializeTranscriptArchiveInWorker(plan)).rejects.toThrow(
      "Archive exceeds 1024 bytes during encoding",
    );
    expect(
      fs
        .readdirSync(path.dirname(storePath))
        .filter((entry) => entry.includes(".stage") || entry.includes("jsonl-stage")),
    ).toEqual([]);
  });
});
