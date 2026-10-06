import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resolveSqliteTranscriptArchiveDirectory } from "../config/sessions/session-accessor.sqlite-scope.js";
import { runWithAgentDatabaseMaintenanceAuthority } from "../state/openclaw-agent-db-lease.js";
import { requireNodeSqlite } from "./node-sqlite.js";
import { recoverTranscriptArchivePublication } from "./state-migrations.transcript-archive-publication.js";
import {
  migrateCanonicalTranscriptArchives,
  TRANSCRIPT_DIRECTIVE_MIGRATION_BATCH_SIZE,
  transcriptDirectiveArchivesNeedMigration,
} from "./state-migrations.transcript-directives-archives.js";

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
      transformContent?: (content: string) => { changed: boolean; content: string };
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
        transformContent: options.transformContent ?? ((content) => ({ changed: false, content })),
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
    pathname,
    progress: () => database.prepare("SELECT value FROM progress").get()?.value,
    close: () => database.close(),
  };
}

function archiveBlob(database: DatabaseSync, sessionId: string): Buffer {
  const value = database
    .prepare("SELECT archive_blob FROM session_transcript_archives WHERE session_id = ?")
    .get(sessionId)?.archive_blob;
  if (!(value instanceof Uint8Array)) {
    throw new Error(`Missing archive blob for ${sessionId}`);
  }
  return Buffer.from(value);
}

function changeContent(content: string) {
  return { changed: content.includes("old"), content: content.replace("old", "new") };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("canonical transcript archive batch transactions", () => {
  it("checkpoints unchanged archives once per bounded batch", async () => {
    const f = fixture(TRANSCRIPT_DIRECTIVE_MIGRATION_BATCH_SIZE + 3);
    try {
      const before = f.database
        .prepare("SELECT archive_sha256 FROM session_transcript_archives ORDER BY session_id")
        .all();
      const result = await f.migrate();
      expect(result.rewrittenArchives).toBe(0);
      expect(result.warnings[0]).toContain("Missing 35 canonical transcript archive file(s)");
      expect(
        f.database
          .prepare("SELECT archive_sha256 FROM session_transcript_archives ORDER BY session_id")
          .all(),
      ).toEqual(before);
      expect(f.progress()).toBe('{"phase":"complete"}');
      expect(f.transactions).toBe(3); // One cursor write per batch, plus completion.
      expect(f.checks).toBe(6); // Entry and pre-commit for every transaction.
    } finally {
      f.close();
    }
  });

  it("rewrites changed blobs and atomically repairs published files", async () => {
    const f = fixture();
    try {
      const result = await f.migrate({
        transformContent: changeContent,
        onArchive: (archivePath) => {
          fs.mkdirSync(path.dirname(archivePath), { recursive: true });
          fs.writeFileSync(archivePath, originalContent);
        },
      });
      expect(result).toEqual({ rewrittenArchives: 3, warnings: [] });
      for (let index = 0; index < 3; index++) {
        const sessionId = `s${String(index).padStart(5, "0")}`;
        const blob = archiveBlob(f.database, sessionId);
        const row = f.database
          .prepare(
            "SELECT archive_sha256, published_at FROM session_transcript_archives WHERE session_id = ?",
          )
          .get(sessionId);
        expect(blob.toString()).toContain("new");
        expect(row?.archive_sha256).toBe(sha256(blob));
        expect(row?.published_at).toBe(123);
        expect(fs.readFileSync(path.join(f.archiveDirectory, `archive-${index}.jsonl`))).toEqual(
          blob,
        );
      }
      expect(f.transactions).toBe(3);
    } finally {
      f.close();
    }
  });

  it("keeps changed blobs pending when copies are missing", async () => {
    const f = fixture();
    try {
      const result = await f.migrate({ transformContent: changeContent });
      expect(result.rewrittenArchives).toBe(3);
      expect(result.warnings[0]).toContain("Missing 3 canonical transcript archive file(s)");
      expect(
        f.database
          .prepare(
            "SELECT count(*) AS count FROM session_transcript_archives WHERE published_at IS NULL",
          )
          .get()?.count,
      ).toBe(3);
      expect(archiveBlob(f.database, "s00000").toString()).toContain("new");
    } finally {
      f.close();
    }
  });

  it("rejects corruption before writing any row or cursor", async () => {
    const f = fixture();
    try {
      f.database
        .prepare(
          "UPDATE session_transcript_archives SET archive_sha256 = 'invalid' WHERE session_id = 's00002'",
        )
        .run();
      await expect(f.migrate()).rejects.toThrow(/archive-2\.jsonl.*is corrupt/);
      expect(f.transactions).toBe(0);
      expect(f.progress()).toBe("start");
    } finally {
      f.close();
    }
  });

  it("rolls back prior rewrites when the final source row drifts", async () => {
    const f = fixture();
    try {
      let drifted = false;
      await expect(
        f.migrate({
          transformContent: changeContent,
          onArchive: () => {
            if (!drifted) {
              drifted = true;
              const bytes = Buffer.from("drift");
              f.database
                .prepare(
                  "UPDATE session_transcript_archives SET archive_blob = ?, archive_sha256 = ? WHERE session_id = 's00002'",
                )
                .run(bytes, sha256(bytes));
            }
          },
        }),
      ).rejects.toThrow(/source changed/);
      expect(archiveBlob(f.database, "s00000").toString()).toContain("old");
      expect(f.progress()).toBe("start");
    } finally {
      f.close();
    }
  });

  it("rolls back the rewrite batch if authority is lost before commit", async () => {
    const f = fixture();
    try {
      f.failAt(2);
      await expect(f.migrate({ transformContent: changeContent })).rejects.toThrow(
        "maintenance lease lost",
      );
      expect(archiveBlob(f.database, "s00000").toString()).toContain("old");
      expect(f.progress()).toBe("start");
    } finally {
      f.close();
    }
  });

  it("honors cancellation before starting a planned rewrite batch", async () => {
    const f = fixture();
    try {
      const controller = new AbortController();
      await expect(
        f.migrate({
          signal: controller.signal,
          transformContent: changeContent,
          onArchive: () => controller.abort(new Error("operator cancelled Doctor")),
        }),
      ).rejects.toThrow("operator cancelled Doctor");
      expect(f.transactions).toBe(0);
      expect(f.progress()).toBe("start");
      expect(archiveBlob(f.database, "s00000").toString()).toContain("old");
    } finally {
      f.close();
    }
  });

  it("rolls back a failed cursor batch and resumes from the original cursor", async () => {
    const f = fixture();
    try {
      let writes = 0;
      await expect(
        f.migrate({
          writeCursor: (cursor) => {
            f.database.prepare("UPDATE progress SET value = ?").run(JSON.stringify(cursor));
            if (++writes === 2) {
              throw new Error("cursor write failed");
            }
          },
        }),
      ).rejects.toThrow("cursor write failed");
      expect(f.progress()).toBe("start");
      expect((await f.migrate()).rewrittenArchives).toBe(0);
      expect(f.progress()).toBe('{"phase":"complete"}');
    } finally {
      f.close();
    }
  });

  it("restores changed published archives after a cursor write fails", async () => {
    const f = fixture();
    try {
      let writes = 0;
      const prepareFile = (archivePath: string) => {
        if (!fs.existsSync(archivePath)) {
          fs.mkdirSync(path.dirname(archivePath), { recursive: true });
          fs.writeFileSync(archivePath, originalContent);
        }
      };
      await expect(
        f.migrate({
          transformContent: changeContent,
          onArchive: prepareFile,
          writeCursor: (cursor) => {
            f.database.prepare("UPDATE progress SET value = ?").run(JSON.stringify(cursor));
            if (++writes === 2) {
              throw new Error("cursor write failed");
            }
          },
        }),
      ).rejects.toThrow("cursor write failed");
      expect(f.progress()).toBe("start");
      expect(
        f.database
          .prepare(
            "SELECT count(*) AS count FROM session_transcript_archives WHERE published_at IS NULL",
          )
          .get()?.count,
      ).toBe(3);
      expect(f.database.prepare("SELECT count(*) AS count FROM schema_meta").get()?.count).toBe(1);
      expect(
        transcriptDirectiveArchivesNeedMigration(f.database, { generation: "", sessionId: "" }),
      ).toBe(true);

      expect(
        (await f.migrate({ transformContent: changeContent, onArchive: prepareFile }))
          .rewrittenArchives,
      ).toBe(0);
      for (let index = 0; index < 3; index++) {
        const sessionId = `s${String(index).padStart(5, "0")}`;
        const blob = archiveBlob(f.database, sessionId);
        const row = f.database
          .prepare("SELECT published_at FROM session_transcript_archives WHERE session_id = ?")
          .get(sessionId);
        expect(blob.toString()).toContain("new");
        expect(row?.published_at).toBe(123);
        expect(fs.readFileSync(path.join(f.archiveDirectory, `archive-${index}.jsonl`))).toEqual(
          blob,
        );
      }
      expect(f.database.prepare("SELECT count(*) AS count FROM schema_meta").get()?.count).toBe(0);
    } finally {
      f.close();
    }
  });

  it("retries changed published archives after a later file repair fails", async () => {
    const f = fixture();
    try {
      const prepareFile = (archivePath: string) => {
        if (!fs.existsSync(archivePath)) {
          fs.mkdirSync(path.dirname(archivePath), { recursive: true });
          fs.writeFileSync(archivePath, originalContent);
        }
      };
      const renameSync = fs.renameSync;
      const failedPath = path.join(f.archiveDirectory, "archive-1.jsonl");
      const rename = vi.spyOn(fs, "renameSync").mockImplementation((source, destination) => {
        if (destination === failedPath) {
          throw new Error("file repair failed");
        }
        return renameSync(source, destination);
      });
      await expect(
        f.migrate({ transformContent: changeContent, onArchive: prepareFile }),
      ).rejects.toThrow("file repair failed");
      rename.mockRestore();
      expect(f.progress()).toBe("start");
      expect(f.database.prepare("SELECT count(*) AS count FROM schema_meta").get()?.count).toBe(1);
      for (let index = 0; index < 3; index++) {
        const sessionId = `s${String(index).padStart(5, "0")}`;
        expect(archiveBlob(f.database, sessionId).toString()).toContain("new");
        expect(
          f.database
            .prepare("SELECT published_at FROM session_transcript_archives WHERE session_id = ?")
            .get(sessionId)?.published_at,
        ).toBeNull();
      }
      expect(
        fs.readFileSync(path.join(f.archiveDirectory, "archive-0.jsonl")).toString(),
      ).toContain("new");

      expect(
        (await f.migrate({ transformContent: changeContent, onArchive: prepareFile }))
          .rewrittenArchives,
      ).toBe(0);
      for (let index = 0; index < 3; index++) {
        const sessionId = `s${String(index).padStart(5, "0")}`;
        const blob = archiveBlob(f.database, sessionId);
        expect(blob.toString()).toContain("new");
        expect(
          f.database
            .prepare("SELECT published_at FROM session_transcript_archives WHERE session_id = ?")
            .get(sessionId)?.published_at,
        ).toBe(123);
        expect(fs.readFileSync(path.join(f.archiveDirectory, `archive-${index}.jsonl`))).toEqual(
          blob,
        );
      }
      expect(f.database.prepare("SELECT count(*) AS count FROM schema_meta").get()?.count).toBe(0);
    } finally {
      f.close();
    }
  });

  it("recovers a failed second batch when the caller restarts at the beginning", async () => {
    const f = fixture(TRANSCRIPT_DIRECTIVE_MIGRATION_BATCH_SIZE + 3);
    try {
      const prepareFile = (archivePath: string) => {
        if (!fs.existsSync(archivePath)) {
          fs.mkdirSync(path.dirname(archivePath), { recursive: true });
          fs.writeFileSync(archivePath, originalContent);
        }
      };
      const renameSync = fs.renameSync;
      const failedPath = path.join(f.archiveDirectory, "archive-33.jsonl");
      const rename = vi.spyOn(fs, "renameSync").mockImplementation((source, destination) => {
        if (destination === failedPath) {
          throw new Error("second batch repair failed");
        }
        return renameSync(source, destination);
      });
      await expect(
        f.migrate({ transformContent: changeContent, onArchive: prepareFile }),
      ).rejects.toThrow("second batch repair failed");
      rename.mockRestore();
      expect(f.database.prepare("SELECT count(*) AS count FROM schema_meta").get()?.count).toBe(1);
      expect(
        transcriptDirectiveArchivesNeedMigration(f.database, {
          generation: "g",
          sessionId: "s99999",
        }),
      ).toBe(true);
      expect(
        f.database
          .prepare(
            "SELECT published_at FROM session_transcript_archives WHERE session_id = 's00033'",
          )
          .get()?.published_at,
      ).toBeNull();
      expect(
        (await f.migrate({ transformContent: changeContent, onArchive: prepareFile }))
          .rewrittenArchives,
      ).toBe(0);
      expect(f.database.prepare("SELECT count(*) AS count FROM schema_meta").get()?.count).toBe(0);
      expect(
        transcriptDirectiveArchivesNeedMigration(f.database, {
          generation: "g",
          sessionId: "s99999",
        }),
      ).toBe(false);
      expect(
        f.database
          .prepare(
            "SELECT count(*) AS count FROM session_transcript_archives WHERE published_at = 123",
          )
          .get()?.count,
      ).toBe(35);
    } finally {
      f.close();
    }
  });

  it("settles a recovery journal in bounded batches", async () => {
    const f = fixture(TRANSCRIPT_DIRECTIVE_MIGRATION_BATCH_SIZE + 3);
    try {
      await f.migrate({ transformContent: changeContent });
      const transactionsBeforeRecovery = f.transactions;
      const warnings = await runWithAgentDatabaseMaintenanceAuthority(
        {
          signal: new AbortController().signal,
          assertOwned() {},
          assertOwnedInTransaction() {},
        },
        f.pathname,
        () =>
          recoverTranscriptArchivePublication({
            agentId: "main",
            archiveDirectory: f.archiveDirectory,
            database: f.database,
            pathname: f.pathname,
            onArchive: (archivePath) => {
              fs.mkdirSync(path.dirname(archivePath), { recursive: true });
              fs.writeFileSync(archivePath, originalContent);
            },
          }),
      );

      expect(warnings).toEqual([]);
      expect(f.transactions - transactionsBeforeRecovery).toBe(2);
      expect(f.database.prepare("SELECT count(*) AS count FROM schema_meta").get()?.count).toBe(0);
      expect(
        f.database
          .prepare(
            "SELECT count(*) AS count FROM session_transcript_archives WHERE published_at = 123",
          )
          .get()?.count,
      ).toBe(TRANSCRIPT_DIRECTIVE_MIGRATION_BATCH_SIZE + 3);
    } finally {
      f.close();
    }
  });

  it("keeps a missing-file receipt across later batches until its copy returns", async () => {
    const f = fixture(TRANSCRIPT_DIRECTIVE_MIGRATION_BATCH_SIZE + 3);
    try {
      const missingPath = path.join(f.archiveDirectory, "archive-1.jsonl");
      let leaveMissing = false;
      const prepareFile = (archivePath: string) => {
        if (leaveMissing && archivePath === missingPath) {
          return;
        }
        if (!fs.existsSync(archivePath)) {
          fs.mkdirSync(path.dirname(archivePath), { recursive: true });
          fs.writeFileSync(archivePath, originalContent);
        }
      };
      await expect(
        f.migrate({
          transformContent: changeContent,
          onArchive: prepareFile,
          writeCursor: () => {
            throw new Error("cursor write failed");
          },
        }),
      ).rejects.toThrow("cursor write failed");
      fs.unlinkSync(missingPath);
      leaveMissing = true;

      const retry = await f.migrate({ transformContent: changeContent, onArchive: prepareFile });
      expect(retry.rewrittenArchives).toBe(3);
      expect(retry.warnings[0]).toContain("Missing 1 canonical transcript archive file(s)");
      expect(f.database.prepare("SELECT count(*) AS count FROM schema_meta").get()?.count).toBe(1);
      expect(
        transcriptDirectiveArchivesNeedMigration(f.database, {
          generation: "g",
          sessionId: "s99999",
        }),
      ).toBe(true);
      expect(
        f.database
          .prepare(
            "SELECT published_at FROM session_transcript_archives WHERE session_id = 's00001'",
          )
          .get()?.published_at,
      ).toBeNull();
      expect(
        f.database
          .prepare(
            "SELECT published_at FROM session_transcript_archives WHERE session_id = 's00034'",
          )
          .get()?.published_at,
      ).toBe(123);

      fs.writeFileSync(missingPath, originalContent);
      const recovered = await f.migrate({ transformContent: changeContent });
      expect(recovered.rewrittenArchives).toBe(0);
      expect(f.database.prepare("SELECT count(*) AS count FROM schema_meta").get()?.count).toBe(0);
      expect(
        transcriptDirectiveArchivesNeedMigration(f.database, {
          generation: "g",
          sessionId: "s99999",
        }),
      ).toBe(false);
      expect(
        f.database
          .prepare(
            "SELECT published_at FROM session_transcript_archives WHERE session_id = 's00001'",
          )
          .get()?.published_at,
      ).toBe(123);
      expect(fs.readFileSync(missingPath)).toEqual(archiveBlob(f.database, "s00001"));
    } finally {
      f.close();
    }
  });

  it("lets runtime publication supersede an interrupted Doctor receipt", async () => {
    const f = fixture(1);
    try {
      await expect(
        f.migrate({
          transformContent: changeContent,
          writeCursor: () => {
            throw new Error("cursor write failed");
          },
        }),
      ).rejects.toThrow("cursor write failed");
      const archivePath = path.join(f.archiveDirectory, "archive-0.jsonl");
      fs.mkdirSync(f.archiveDirectory, { recursive: true });
      fs.writeFileSync(archivePath, archiveBlob(f.database, "s00000"));
      f.database
        .prepare(
          "UPDATE session_transcript_archives SET published_at = 456 WHERE session_id = 's00000'",
        )
        .run();

      expect(await f.migrate()).toMatchObject({ rewrittenArchives: 0, warnings: [] });
      expect(f.database.prepare("SELECT count(*) AS count FROM schema_meta").get()?.count).toBe(0);
      expect(
        f.database.prepare("SELECT published_at FROM session_transcript_archives").get()
          ?.published_at,
      ).toBe(456);
      expect(fs.readFileSync(archivePath)).toEqual(archiveBlob(f.database, "s00000"));
    } finally {
      f.close();
    }
  });

  it("carries a missing-file receipt through another transform of the pending blob", async () => {
    const f = fixture(1);
    try {
      const archivePath = path.join(f.archiveDirectory, "archive-0.jsonl");
      await f.migrate({
        transformContent: (content) => ({
          changed: content.includes("old"),
          content: content.replace("old", "middle"),
        }),
      });
      await f.migrate({
        transformContent: (content) => ({
          changed: content.includes("middle"),
          content: content.replace("middle", "new"),
        }),
      });
      expect(archiveBlob(f.database, "s00000").toString()).toContain("new");
      expect(
        f.database.prepare("SELECT published_at FROM session_transcript_archives").get()
          ?.published_at,
      ).toBeNull();

      fs.mkdirSync(f.archiveDirectory, { recursive: true });
      fs.writeFileSync(archivePath, originalContent);
      await f.migrate();
      expect(
        f.database.prepare("SELECT published_at FROM session_transcript_archives").get()
          ?.published_at,
      ).toBe(123);
      expect(fs.readFileSync(archivePath)).toEqual(archiveBlob(f.database, "s00000"));
      expect(f.database.prepare("SELECT count(*) AS count FROM schema_meta").get()?.count).toBe(0);
    } finally {
      f.close();
    }
  });

  it("recovers surviving rows after deletion, insertion, and another rewrite", async () => {
    const f = fixture();
    try {
      const prepareFile = (archivePath: string) => {
        if (!fs.existsSync(archivePath)) {
          fs.mkdirSync(path.dirname(archivePath), { recursive: true });
          fs.writeFileSync(archivePath, originalContent);
        }
      };
      await expect(
        f.migrate({
          transformContent: changeContent,
          onArchive: prepareFile,
          writeCursor: () => {
            throw new Error("cursor write failed");
          },
        }),
      ).rejects.toThrow("cursor write failed");
      f.database
        .prepare("DELETE FROM session_transcript_archives WHERE session_id = 's00000'")
        .run();
      const inserted = Buffer.from(originalContent.replace("old", "inserted"));
      f.database
        .prepare(
          "INSERT INTO session_transcript_archives VALUES (?, 'g', ?, ?, ?, 'identity', 456)",
        )
        .run("s00000a", inserted, "inserted.jsonl", sha256(inserted));
      const rewritten = Buffer.from(originalContent.replace("old", "independently rewritten"));
      f.database
        .prepare(
          "UPDATE session_transcript_archives SET archive_blob = ?, archive_sha256 = ? WHERE session_id = 's00001'",
        )
        .run(rewritten, sha256(rewritten));

      await f.migrate({ transformContent: changeContent, onArchive: prepareFile });
      expect(f.database.prepare("SELECT count(*) AS count FROM schema_meta").get()?.count).toBe(0);
      expect(
        f.database
          .prepare(
            "SELECT published_at FROM session_transcript_archives WHERE session_id = 's00002'",
          )
          .get()?.published_at,
      ).toBe(123);
      expect(
        f.database
          .prepare(
            "SELECT published_at FROM session_transcript_archives WHERE session_id = 's00001'",
          )
          .get()?.published_at,
      ).toBeNull();
      expect(
        f.database
          .prepare(
            "SELECT published_at FROM session_transcript_archives WHERE session_id = 's00000a'",
          )
          .get()?.published_at,
      ).toBe(456);
    } finally {
      f.close();
    }
  });

  it("carries original publication across a sibling transform after a failed batch", async () => {
    const f = fixture();
    try {
      const prepareFile = (archivePath: string) => {
        if (!fs.existsSync(archivePath)) {
          fs.mkdirSync(path.dirname(archivePath), { recursive: true });
          fs.writeFileSync(archivePath, originalContent);
        }
      };
      await expect(
        f.migrate({
          transformContent: (content) => ({
            changed: content.includes("old"),
            content: content.replace("old", "middle"),
          }),
          onArchive: prepareFile,
          writeCursor: () => {
            throw new Error("first migration cursor failed");
          },
        }),
      ).rejects.toThrow("first migration cursor failed");
      expect(f.database.prepare("SELECT count(*) AS count FROM schema_meta").get()?.count).toBe(1);

      const sibling = await f.migrate({
        transformContent: (content) => ({
          changed: content.includes("middle"),
          content: content.replace("middle", "new"),
        }),
      });
      expect(sibling.rewrittenArchives).toBe(3);
      expect(f.database.prepare("SELECT count(*) AS count FROM schema_meta").get()?.count).toBe(0);
      for (let index = 0; index < 3; index++) {
        const sessionId = `s${String(index).padStart(5, "0")}`;
        const blob = archiveBlob(f.database, sessionId);
        expect(blob.toString()).toContain("new");
        expect(
          f.database
            .prepare("SELECT published_at FROM session_transcript_archives WHERE session_id = ?")
            .get(sessionId)?.published_at,
        ).toBe(123);
        expect(fs.readFileSync(path.join(f.archiveDirectory, `archive-${index}.jsonl`))).toEqual(
          blob,
        );
      }
    } finally {
      f.close();
    }
  });

  it("rejects archive paths outside the artifact directory", async () => {
    const f = fixture();
    try {
      f.database
        .prepare(
          "UPDATE session_transcript_archives SET archive_name = '../escape.jsonl' WHERE session_id = 's00001'",
        )
        .run();
      await expect(f.migrate()).rejects.toThrow(/outside/);
      expect(f.progress()).toBe("start");
    } finally {
      f.close();
    }
  });

  it("skips a source row deleted after planning without recreating it", async () => {
    const f = fixture();
    try {
      let deleted = false;
      const result = await f.migrate({
        transformContent: changeContent,
        onArchive: () => {
          if (!deleted) {
            deleted = true;
            f.database
              .prepare("DELETE FROM session_transcript_archives WHERE session_id = 's00001'")
              .run();
          }
        },
      });
      expect(result.rewrittenArchives).toBe(2);
      expect(
        f.database.prepare("SELECT count(*) AS count FROM session_transcript_archives").get()
          ?.count,
      ).toBe(2);
    } finally {
      f.close();
    }
  });
});
