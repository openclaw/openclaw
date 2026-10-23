import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { zstdCompressSync, zstdDecompressSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as archiveCompression from "../config/sessions/archive-compression.js";
import { resolveSqliteTranscriptArchiveDirectory } from "../config/sessions/session-accessor.sqlite-scope.js";
import { runWithAgentDatabaseMaintenanceAuthority } from "../state/openclaw-agent-db-lease.js";
import { requireNodeSqlite } from "./node-sqlite.js";
import { recoverTranscriptArchivePublication } from "./state-migrations.transcript-archive-publication.js";
import {
  migrateCanonicalTranscriptArchives,
  TRANSCRIPT_DIRECTIVE_MIGRATION_BATCH_SIZE,
  transcriptDirectiveArchivesNeedMigration,
} from "./state-migrations.transcript-directives-archives.js";

function readRow(db: DatabaseSync, sql: string, ...params: SQLInputValue[]) {
  return db.prepare(sql).get(...params);
}

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const originalContent = `${JSON.stringify({ type: "message", message: { role: "user", content: "old" } })}\n`;

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function fixture(count = 3) {
  const directory = tempDirs.make("archive-batch-");
  const pathname = path.join(directory, "agent.sqlite");
  const { DatabaseSync } = requireNodeSqlite();
  const database = new DatabaseSync(pathname);
  database.exec(`
    CREATE TABLE schema_meta (
      meta_key TEXT NOT NULL PRIMARY KEY, role TEXT NOT NULL, schema_version INTEGER NOT NULL,
      agent_id TEXT, app_version TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE session_transcript_archives (
      session_id TEXT NOT NULL, generation TEXT NOT NULL, archive_blob BLOB NOT NULL,
      archive_name TEXT NOT NULL, archive_sha256 TEXT NOT NULL, encoding TEXT NOT NULL,
      published_at INTEGER, PRIMARY KEY (session_id, generation)
    );
    CREATE TABLE progress (value TEXT NOT NULL);
    INSERT INTO progress VALUES ('start');
  `);
  const bytes = Buffer.from(originalContent);
  const insert = database.prepare(
    "INSERT INTO session_transcript_archives VALUES (?, ?, ?, ?, ?, 'identity', 123)",
  );
  for (let index = 0; index < count; index++) {
    insert.run(
      `s${String(index).padStart(5, "0")}`,
      "g",
      bytes,
      `archive-${index}.jsonl`,
      sha256(bytes),
    );
  }

  let checks = 0;
  let transactions = 0;
  let failAtCheck: number | undefined;
  const nativeExec = database.exec.bind(database);
  vi.spyOn(database, "exec").mockImplementation((sql) => {
    if (sql === "BEGIN IMMEDIATE") {
      transactions += 1;
    }
    return nativeExec(sql);
  });
  const authority = {
    signal: new AbortController().signal,
    assertOwned() {
      checks += 1;
      if (checks === failAtCheck) {
        throw new Error("maintenance lease lost");
      }
    },
    assertOwnedInTransaction() {},
    renew() {},
  };
  const archiveDirectory = resolveSqliteTranscriptArchiveDirectory({
    agentId: "main",
    path: pathname,
  });
  const writeCursor = (
    cursor: { generation: string; sessionId: string } | { phase: "complete" },
  ) => {
    database.prepare("UPDATE progress SET value = ?").run(JSON.stringify(cursor));
  };
  const migrate = (
    options: {
      onArchive?: (archivePath: string) => void;
      signal?: AbortSignal;
      transformLine?: (content: string) => { changed: boolean; content: string };
      writeCursor?: typeof writeCursor;
    } = {},
  ) =>
    runWithAgentDatabaseMaintenanceAuthority(authority, pathname, () =>
      migrateCanonicalTranscriptArchives({
        agentId: "main",
        database,
        pathname,
        signal: options.signal,
        start: { generation: "", sessionId: "" },
        writeCursor: options.writeCursor ?? writeCursor,
        transformLine: options.transformLine ?? ((content) => ({ changed: false, content })),
        onArchive: options.onArchive,
      }),
    );
  return {
    archiveDirectory,
    database,
    get checks() {
      return checks;
    },
    get transactions() {
      return transactions;
    },
    failAt(check: number) {
      failAtCheck = check;
    },
    migrate,
    rewrite: (options: Parameters<typeof migrate>[0] = {}) =>
      migrate({ transformLine: changeContent, onArchive: prepareArchiveFile, ...options }),
    blob: (sessionId: string) => archiveBlob(database, sessionId),
    hashes: () =>
      database
        .prepare("SELECT archive_sha256 FROM session_transcript_archives ORDER BY session_id")
        .all(),
    pathname,
    publishedAt: (sessionId = "s00000") =>
      readRow(
        database,
        "SELECT published_at FROM session_transcript_archives WHERE session_id = ?",
        sessionId,
      )?.published_at,
    publishedCount: () =>
      readRow(
        database,
        "SELECT count(*) AS count FROM session_transcript_archives WHERE published_at = 123",
      )?.count,
    get journalCount() {
      return readRow(database, "SELECT count(*) AS count FROM schema_meta")?.count;
    },
    needsMigration: (start = { generation: "g", sessionId: "s99999" }) =>
      transcriptDirectiveArchivesNeedMigration(database, start),
    get progress() {
      return readRow(database, "SELECT value FROM progress")?.value;
    },
    [Symbol.dispose]: () => database.close(),
  };
}

function archiveBlob(database: DatabaseSync, sessionId: string): Buffer {
  const value = readRow(
    database,
    "SELECT archive_blob FROM session_transcript_archives WHERE session_id = ?",
    sessionId,
  )?.archive_blob;
  if (!(value instanceof Uint8Array)) {
    throw new Error(`Missing archive blob for ${sessionId}`);
  }
  return Buffer.from(value);
}

function failCursor(): never {
  throw new Error("cursor write failed");
}

function replaceContent(from: string, to: string) {
  return (content: string) => ({
    changed: content.includes(from),
    content: content.replace(from, to),
  });
}

const changeContent = replaceContent("old", "new");

function writeArchiveFile(archivePath: string, content: string | Uint8Array = originalContent) {
  fs.mkdirSync(path.dirname(archivePath), { recursive: true });
  fs.writeFileSync(archivePath, content);
}

function prepareArchiveFile(archivePath: string) {
  if (!fs.existsSync(archivePath)) {
    writeArchiveFile(archivePath);
  }
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("canonical transcript archive batch transactions", () => {
  it("keeps canonical bytes and progress retryable after second-pass zstd cancellation", async () => {
    using f = fixture(1);
    const source = zstdCompressSync(Buffer.from(originalContent));
    f.database
      .prepare(
        "UPDATE session_transcript_archives SET archive_blob = ?, archive_sha256 = ?, encoding = 'zstd', archive_name = 'archive-0.jsonl.zst'",
      )
      .run(source, sha256(source));
    const controller = new AbortController();
    const interrupted = new Error("Doctor interrupted during recompression");
    let calls = 0;
    await expect(
      f.migrate({
        signal: controller.signal,
        transformLine: (line) => {
          if (++calls === 2) {
            controller.abort(interrupted);
            controller.signal.throwIfAborted();
          }
          return changeContent(line);
        },
      }),
    ).rejects.toBe(interrupted);
    expect(f.blob("s00000")).toEqual(source);
    expect(f).toMatchObject({ progress: "start", transactions: 0 });
    await f.rewrite({ onArchive: undefined });
    expect(zstdDecompressSync(f.blob("s00000")).toString()).toBe(
      originalContent.replace("old", "new"),
    );
    expect(f.progress).toBe('{"phase":"complete"}');
  });

  it("inspects compressed historical directives without whole-archive string decoding", async () => {
    using f = fixture(1);
    const content = JSON.stringify({
      type: "message",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "[[reply_to_current]] hello 🙂" }],
      },
    });
    const source = zstdCompressSync(Buffer.from(content));
    f.database
      .prepare(
        "UPDATE session_transcript_archives SET archive_blob = ?, archive_sha256 = ?, encoding = 'zstd'",
      )
      .run(source, sha256(source));
    vi.spyOn(archiveCompression, "decodeSessionArchiveBytes").mockImplementation(() => {
      throw new RangeError("Cannot create a string longer than 0x1fffffe8 characters");
    });
    await expect(f.needsMigration({ generation: "", sessionId: "" })).resolves.toBe(true);
    expect(f.blob("s00000")).toEqual(source);
    expect(f.progress).toBe("start");
  });

  it("checkpoints unchanged archives once per bounded batch", async () => {
    using f = fixture(TRANSCRIPT_DIRECTIVE_MIGRATION_BATCH_SIZE + 3);
    const before = f.hashes();
    const result = await f.migrate();
    expect(result.rewrittenArchives).toBe(0);
    expect(result.warnings[0]).toContain("Missing 35 canonical transcript archive file(s)");
    expect(f.hashes()).toEqual(before);
    // Each batch and completion writes once, checking authority on entry and before commit.
    expect(f).toMatchObject({ progress: '{"phase":"complete"}', transactions: 3, checks: 6 });
  });

  it("rejects corruption before writing any row or cursor", async () => {
    using f = fixture();
    f.database
      .prepare(
        "UPDATE session_transcript_archives SET archive_sha256 = 'invalid' WHERE session_id = 's00002'",
      )
      .run();
    await expect(f.migrate()).rejects.toThrow(/archive-2\.jsonl.*is corrupt/);
    expect(f).toMatchObject({ progress: "start", transactions: 0 });
  });

  it("rolls back the rewrite batch if authority is lost before commit", async () => {
    using f = fixture();
    f.failAt(2);
    await expect(f.rewrite({ onArchive: undefined })).rejects.toThrow("maintenance lease lost");
    expect(f.blob("s00000").toString()).toContain("old");
    expect(f.progress).toBe("start");
  });

  it("honors cancellation before starting a planned rewrite batch", async () => {
    using f = fixture();
    const controller = new AbortController();
    await expect(
      f.migrate({
        signal: controller.signal,
        transformLine: changeContent,
        onArchive: () => controller.abort(new Error("operator cancelled Doctor")),
      }),
    ).rejects.toThrow("operator cancelled Doctor");
    expect(f).toMatchObject({ progress: "start", transactions: 0 });
    expect(f.blob("s00000").toString()).toContain("old");
  });

  it("restores changed published archives after a cursor write fails", async () => {
    using f = fixture();
    let writes = 0;
    await expect(
      f.rewrite({
        writeCursor: (cursor) => {
          f.database.prepare("UPDATE progress SET value = ?").run(JSON.stringify(cursor));
          if (++writes === 2) {
            throw new Error("cursor write failed");
          }
        },
      }),
    ).rejects.toThrow("cursor write failed");
    expect(f.progress).toBe("start");
    expect(
      readRow(
        f.database,
        "SELECT count(*) AS count FROM session_transcript_archives WHERE published_at IS NULL",
      )?.count,
    ).toBe(3);
    expect(f.journalCount).toBe(1);
    expect(await f.needsMigration({ generation: "", sessionId: "" })).toBe(true);

    expect((await f.rewrite()).rewrittenArchives).toBe(0);
    for (let index = 0; index < 3; index++) {
      const sessionId = `s${String(index).padStart(5, "0")}`;
      const blob = f.blob(sessionId);
      const row = readRow(
        f.database,
        "SELECT published_at FROM session_transcript_archives WHERE session_id = ?",
        sessionId,
      );
      expect(blob.toString()).toContain("new");
      expect(row?.published_at).toBe(123);
      expect(fs.readFileSync(path.join(f.archiveDirectory, `archive-${index}.jsonl`))).toEqual(
        blob,
      );
    }
    expect(f.journalCount).toBe(0);
  });

  it("recovers a failed second batch when the caller restarts at the beginning", async () => {
    using f = fixture(TRANSCRIPT_DIRECTIVE_MIGRATION_BATCH_SIZE + 3);
    const renameSync = fs.renameSync;
    const failedPath = path.join(f.archiveDirectory, "archive-33.jsonl");
    const rename = vi.spyOn(fs, "renameSync").mockImplementation((source, destination) => {
      if (destination === failedPath) {
        throw new Error("second batch repair failed");
      }
      return renameSync(source, destination);
    });
    await expect(f.rewrite()).rejects.toThrow("second batch repair failed");
    rename.mockRestore();
    expect(fs.readFileSync(path.join(f.archiveDirectory, "archive-32.jsonl"))).toEqual(
      f.blob("s00032"),
    );
    expect(f.journalCount).toBe(1);
    expect(await f.needsMigration()).toBe(true);
    expect(f.publishedAt("s00033")).toBeNull();
    expect((await f.rewrite()).rewrittenArchives).toBe(0);
    expect(f.journalCount).toBe(0);
    expect(await f.needsMigration()).toBe(false);
    expect(f.publishedCount()).toBe(35);
    expect(fs.readFileSync(failedPath)).toEqual(f.blob("s00033"));
  });

  it("settles a recovery journal in bounded batches", async () => {
    using f = fixture(TRANSCRIPT_DIRECTIVE_MIGRATION_BATCH_SIZE + 3);
    await f.rewrite({ onArchive: undefined });
    const transactionsBeforeRecovery = f.transactions;
    const warnings = await runWithAgentDatabaseMaintenanceAuthority(
      { signal: new AbortController().signal, assertOwned() {}, assertOwnedInTransaction() {} },
      f.pathname,
      () =>
        recoverTranscriptArchivePublication({
          agentId: "main",
          archiveDirectory: f.archiveDirectory,
          database: f.database,
          pathname: f.pathname,
          onArchive: writeArchiveFile,
        }),
    );

    expect(warnings).toEqual([]);
    expect(f.transactions - transactionsBeforeRecovery).toBe(2);
    expect(f.journalCount).toBe(0);
    expect(f.publishedCount()).toBe(TRANSCRIPT_DIRECTIVE_MIGRATION_BATCH_SIZE + 3);
  });

  it("keeps a missing-file receipt across later batches until its copy returns", async () => {
    using f = fixture(TRANSCRIPT_DIRECTIVE_MIGRATION_BATCH_SIZE + 3);
    const missingPath = path.join(f.archiveDirectory, "archive-1.jsonl");
    let leaveMissing = false;
    const prepareFile = (archivePath: string) => {
      if (!leaveMissing || archivePath !== missingPath) {
        prepareArchiveFile(archivePath);
      }
    };
    await expect(f.rewrite({ onArchive: prepareFile, writeCursor: failCursor })).rejects.toThrow(
      "cursor write failed",
    );
    fs.unlinkSync(missingPath);
    leaveMissing = true;

    const retry = await f.rewrite({ onArchive: prepareFile });
    expect(retry.rewrittenArchives).toBe(3);
    expect(retry.warnings[0]).toContain("Missing 1 canonical transcript archive file(s)");
    expect(f.journalCount).toBe(1);
    expect(await f.needsMigration()).toBe(true);
    expect(f.publishedAt("s00001")).toBeNull();
    expect(f.publishedAt("s00034")).toBe(123);

    fs.writeFileSync(missingPath, originalContent);
    const recovered = await f.rewrite({ onArchive: undefined });
    expect(recovered.rewrittenArchives).toBe(0);
    expect(f.journalCount).toBe(0);
    expect(await f.needsMigration()).toBe(false);
    expect(f.publishedAt("s00001")).toBe(123);
    expect(fs.readFileSync(missingPath)).toEqual(f.blob("s00001"));
  });

  it("lets runtime publication supersede an interrupted Doctor receipt", async () => {
    using f = fixture(1);
    await expect(f.rewrite({ onArchive: undefined, writeCursor: failCursor })).rejects.toThrow(
      "cursor write failed",
    );
    const archivePath = path.join(f.archiveDirectory, "archive-0.jsonl");
    writeArchiveFile(archivePath, f.blob("s00000"));
    f.database
      .prepare(
        "UPDATE session_transcript_archives SET published_at = 456 WHERE session_id = 's00000'",
      )
      .run();

    expect(await f.migrate()).toMatchObject({ rewrittenArchives: 0, warnings: [] });
    expect(f.journalCount).toBe(0);
    expect(f.publishedAt()).toBe(456);
    expect(fs.readFileSync(archivePath)).toEqual(f.blob("s00000"));
  });

  it("carries a missing-file receipt through another transform of the pending blob", async () => {
    using f = fixture(1);
    const archivePath = path.join(f.archiveDirectory, "archive-0.jsonl");
    await f.migrate({ transformLine: replaceContent("old", "middle") });
    await f.migrate({ transformLine: replaceContent("middle", "new") });
    expect(f.blob("s00000").toString()).toContain("new");
    expect(f.publishedAt()).toBeNull();

    writeArchiveFile(archivePath);
    await f.migrate();
    expect(f.publishedAt()).toBe(123);
    expect(fs.readFileSync(archivePath)).toEqual(f.blob("s00000"));
    expect(f.journalCount).toBe(0);
  });

  it("recovers surviving rows after deletion, insertion, and another rewrite", async () => {
    using f = fixture();
    await expect(f.rewrite({ writeCursor: failCursor })).rejects.toThrow("cursor write failed");
    f.database.prepare("DELETE FROM session_transcript_archives WHERE session_id = 's00000'").run();
    const inserted = Buffer.from(originalContent.replace("old", "inserted"));
    f.database
      .prepare("INSERT INTO session_transcript_archives VALUES (?, 'g', ?, ?, ?, 'identity', 456)")
      .run("s00000a", inserted, "inserted.jsonl", sha256(inserted));
    const rewritten = Buffer.from(originalContent.replace("old", "independently rewritten"));
    f.database
      .prepare(
        "UPDATE session_transcript_archives SET archive_blob = ?, archive_sha256 = ? WHERE session_id = 's00001'",
      )
      .run(rewritten, sha256(rewritten));

    await f.rewrite();
    expect(f.journalCount).toBe(0);
    expect(f.publishedAt("s00002")).toBe(123);
    expect(f.publishedAt("s00001")).toBeNull();
    expect(f.publishedAt("s00000a")).toBe(456);
  });

  it("rejects archive paths outside the artifact directory", async () => {
    using f = fixture();
    f.database
      .prepare(
        "UPDATE session_transcript_archives SET archive_name = '../escape.jsonl' WHERE session_id = 's00001'",
      )
      .run();
    await expect(f.migrate()).rejects.toThrow(/outside/);
    expect(f.progress).toBe("start");
  });
});
