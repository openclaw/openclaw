import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeTempDir } from "../../test/helpers/temp-dir.js";
import {
  decodeSessionArchiveBytes,
  encodeSessionArchiveContent,
  SESSION_ARCHIVE_ZSTD_SUFFIX,
} from "../config/sessions/archive-compression.js";
import {
  publishEncodedSessionTranscriptArchive,
  resolveRegisteredSqliteTranscriptArchiveName,
} from "../config/sessions/session-accessor.sqlite-archive-artifact.js";
import { resolveSqliteTranscriptArchiveDirectory } from "../config/sessions/session-accessor.sqlite-scope.js";
import { closeOpenClawAgentDatabasesAsync } from "../state/openclaw-agent-db-lifecycle.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
  withAgentDatabaseMaintenanceLease,
} from "../state/openclaw-agent-db.js";
import { ensureSessionTranscriptArchiveSchema } from "../state/openclaw-agent-session-transcript-archive-schema.js";
import { createOpenClawDatabaseMaintenanceScope } from "../state/openclaw-state-db-async-lifecycle.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db-cache.js";
import { clearNodeSqliteKyselyCacheForDatabase } from "./kysely-sync.js";
import { requireNodeSqlite } from "./node-sqlite.js";
import { migrateLegacyMediaPersistence } from "./state-migrations.media-persistence.js";
import { cleanupMediaPersistenceFixtures } from "./state-migrations.media-persistence.test-support.js";
import { migrateCanonicalTranscriptArchives } from "./state-migrations.transcript-directives-archives.js";
import { migrateHistoricalTranscriptDirectives } from "./state-migrations.transcript-directives.js";

type ArchiveEncoding = "identity" | "zstd";
type ArchiveRow = {
  session_id: string;
  generation: string;
  session_key: string;
  reason: string;
  encoding: ArchiveEncoding;
  archive_blob: Uint8Array;
  archive_sha256: string;
  archive_name: string;
  created_at: number;
  published_at: number | null;
};

const tempDirs: string[] = [];
const sessionId = "archived-media";
const generation = "retained-generation";
const publishedAt = 1234;
const preservedEvent = {
  type: "custom",
  id: "preserved",
  parentId: "attachment",
  timestamp: 20,
  data: { MediaPath: "opaque custom data", values: [1, "two"] },
};
const legacyEvent = {
  type: "message",
  id: "attachment",
  parentId: null,
  timestamp: 10,
  message: {
    role: "user",
    content: "keep the attachment",
    MediaPath: "/media/retained.png",
    MediaType: "image/png",
    __openclaw: { preserved: true },
  },
};
const canonicalEvent = {
  type: "message",
  id: "attachment",
  parentId: null,
  timestamp: 10,
  message: {
    role: "user",
    content: "keep the attachment",
    __openclaw: {
      preserved: true,
      media: [{ path: "/media/retained.png", contentType: "image/png" }],
    },
  },
};
const legacyContent = `${JSON.stringify(legacyEvent)}\n${JSON.stringify(preservedEvent)}\n`;
const canonicalContent = `${JSON.stringify(canonicalEvent)}\n${JSON.stringify(preservedEvent)}\n`;

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function encode(content: string, encoding: ArchiveEncoding): Buffer {
  if (encoding === "identity") {
    return Buffer.from(content, "utf8");
  }
  const encoded = encodeSessionArchiveContent(content);
  expect(encoded.suffix).toBe(SESSION_ARCHIVE_ZSTD_SUFFIX);
  return encoded.bytes;
}

function fixture(
  options: {
    encoding?: ArchiveEncoding;
    content?: string;
    fileContent?: string | null;
    digest?: string;
  } = {},
) {
  const stateDir = makeTempDir(tempDirs, "media-canonical-archive-");
  const env = { OPENCLAW_STATE_DIR: stateDir };
  const opened = openOpenClawAgentDatabase({ agentId: "main", env });
  ensureSessionTranscriptArchiveSchema(opened.db);
  const databasePath = opened.path;
  const encoding = options.encoding ?? "identity";
  const content = options.content ?? legacyContent;
  const bytes = encode(content, encoding);
  const archiveDirectory = resolveSqliteTranscriptArchiveDirectory({
    agentId: "main",
    path: databasePath,
  });
  const archiveName = resolveRegisteredSqliteTranscriptArchiveName({
    sessionId,
    generation,
    reason: "deleted",
    encoding,
    createdAt: publishedAt,
  });
  const archivePath = path.join(archiveDirectory, archiveName);
  // Historical fixture: retained generations can outlive their session window.
  // Real exact-import and lifecycle-archive reachability is covered by the external reproduction.
  opened.db
    .prepare(
      `INSERT INTO session_transcript_archives(
        session_id,generation,session_key,reason,encoding,archive_blob,archive_sha256,
        archive_name,created_at,published_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      sessionId,
      generation,
      `agent:main:${sessionId}`,
      "deleted",
      encoding,
      bytes,
      options.digest ?? sha256(bytes),
      archiveName,
      publishedAt,
      publishedAt,
    );
  closeOpenClawAgentDatabasesForTest();
  if (options.fileContent !== null) {
    fs.mkdirSync(archiveDirectory, { recursive: true });
    fs.writeFileSync(archivePath, encode(options.fileContent ?? content, encoding));
  }
  const read = (): ArchiveRow => {
    const { DatabaseSync } = requireNodeSqlite();
    const database = new DatabaseSync(databasePath, { readOnly: true });
    try {
      return database
        .prepare(
          "SELECT * FROM session_transcript_archives WHERE session_id = ? AND generation = ?",
        )
        .get(sessionId, generation) as ArchiveRow;
    } finally {
      database.close();
    }
  };
  return { archiveDirectory, archiveName, archivePath, databasePath, env, read };
}

function expectCanonical(row: ArchiveRow): void {
  expect(sha256(row.archive_blob)).toBe(row.archive_sha256);
  const content = decodeSessionArchiveBytes(row.archive_blob, row.encoding === "zstd");
  expect(content.endsWith("\n")).toBe(true);
  expect(
    content
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line)),
  ).toEqual([canonicalEvent, preservedEvent]);
}

function expectPreservedIdentity(before: ArchiveRow, after: ArchiveRow): void {
  expect({
    sessionId: after.session_id,
    generation: after.generation,
    sessionKey: after.session_key,
    reason: after.reason,
    encoding: after.encoding,
    archiveName: after.archive_name,
    createdAt: after.created_at,
  }).toEqual({
    sessionId: before.session_id,
    generation: before.generation,
    sessionKey: before.session_key,
    reason: before.reason,
    encoding: before.encoding,
    archiveName: before.archive_name,
    createdAt: before.created_at,
  });
}

afterEach(async () => {
  vi.restoreAllMocks();
  await closeOpenClawAgentDatabasesAsync();
  await closeOpenClawStateDatabaseAsync();
  cleanupMediaPersistenceFixtures(tempDirs);
});

describe("media migration of canonical SQLite transcript archives", () => {
  it.each([32, 33])(
    "bounds maintenance checks for %i current archives without changing retained data",
    async (count) => {
      const f = fixture({ content: canonicalContent });
      const { DatabaseSync } = requireNodeSqlite();
      const database = new DatabaseSync(f.databasePath);
      const rows = Array.from({ length: count - 1 }, (_, index) => {
        const session = `archive-${String(index).padStart(3, "0")}`;
        const archiveName = `${session}.jsonl`;
        const bytes = Buffer.from(canonicalContent, "utf8");
        database
          .prepare(
            `INSERT INTO session_transcript_archives(
            session_id,generation,session_key,reason,encoding,archive_blob,archive_sha256,
            archive_name,created_at,published_at
          ) VALUES(?,?,?,?,?,?,?,?,?,?)`,
          )
          .run(
            session,
            "generation",
            `agent:main:${session}`,
            "deleted",
            "identity",
            bytes,
            sha256(bytes),
            archiveName,
            publishedAt,
            publishedAt,
          );
        fs.writeFileSync(path.join(f.archiveDirectory, archiveName), bytes);
        return session;
      });
      database.close();

      const before = f.read();
      let policyChecks = 0;
      let archiveChecks = 0;
      const scope = createOpenClawDatabaseMaintenanceScope({
        schemaMaintenance: true,
        assertOwnerCurrent: () => {
          policyChecks++;
        },
      });
      const cursors: Array<{ generation: string; sessionId: string } | { phase: "complete" }> = [];
      try {
        await scope.run(() =>
          withAgentDatabaseMaintenanceLease({ env: f.env }, async () => {
            const opened = new DatabaseSync(f.databasePath);
            policyChecks = 0;
            try {
              await migrateCanonicalTranscriptArchives({
                agentId: "main",
                database: opened,
                pathname: f.databasePath,
                start: { generation: "", sessionId: "" },
                transformContent: (content) => ({ changed: false, content }),
                writeCursor: (cursor) => cursors.push(cursor),
              });
              archiveChecks = policyChecks;
            } finally {
              clearNodeSqliteKyselyCacheForDatabase(opened);
              opened.close();
            }
          }),
        );
      } finally {
        await scope.close();
      }

      expect(rows).toHaveLength(count - 1);
      expect(archiveChecks).toBeGreaterThan(0);
      expect(archiveChecks).toBeLessThanOrEqual(16 * (Math.ceil(count / 32) + 1));
      expect(f.read()).toEqual(before);
      expect(fs.readFileSync(f.archivePath)).toEqual(Buffer.from(before.archive_blob));
      expect(cursors.filter((cursor) => "phase" in cursor)).toEqual([{ phase: "complete" }]);
      expect(cursors.filter((cursor) => !("phase" in cursor))).toHaveLength(Math.ceil(count / 32));
    },
  );

  it("retains earlier progress when a later published copy cannot be read", async () => {
    const f = fixture({ content: canonicalContent });
    const { DatabaseSync } = requireNodeSqlite();
    const database = new DatabaseSync(f.databasePath);
    try {
      database
        .prepare(`INSERT INTO session_transcript_archives
        (session_id,generation,session_key,reason,encoding,archive_blob,archive_sha256,
          archive_name,created_at,published_at)
        SELECT 'zzz-unreadable', generation, session_key, reason, encoding, archive_blob,
          archive_sha256, 'zzz-unreadable.jsonl', created_at, published_at
        FROM session_transcript_archives WHERE session_id = ?`)
        .run(sessionId);
    } finally {
      database.close();
    }
    fs.mkdirSync(path.join(f.archiveDirectory, "zzz-unreadable.jsonl"));
    const visited: string[] = [];
    const cursors: unknown[] = [];
    await expect(
      withAgentDatabaseMaintenanceLease({ env: f.env }, async () => {
        const opened = new DatabaseSync(f.databasePath);
        try {
          await migrateCanonicalTranscriptArchives({
            agentId: "main",
            database: opened,
            pathname: f.databasePath,
            start: { generation: "", sessionId: "" },
            transformContent: (content) => ({ changed: false, content }),
            onArchive: (archive) => {
              visited.push(archive);
            },
            writeCursor: (cursor) => {
              cursors.push(cursor);
            },
          });
        } finally {
          clearNodeSqliteKyselyCacheForDatabase(opened);
          opened.close();
        }
      }),
    ).rejects.toThrow();
    expect(visited).toEqual([f.archivePath, path.join(f.archiveDirectory, "zzz-unreadable.jsonl")]);
    expect(cursors).toEqual([{ generation, sessionId }]);
    expect(fs.readFileSync(f.archivePath)).toEqual(Buffer.from(f.read().archive_blob));
  });

  it("rolls back a batch cursor when its maintenance owner rejects commit", async () => {
    const f = fixture({ content: canonicalContent });
    const { DatabaseSync } = requireNodeSqlite();
    let rejectCommit = false;
    const scope = createOpenClawDatabaseMaintenanceScope({
      schemaMaintenance: true,
      assertOwnerCurrent: () => {
        if (rejectCommit) {
          rejectCommit = false;
          throw new Error("maintenance owner revoked");
        }
      },
    });
    try {
      await expect(
        scope.run(() =>
          withAgentDatabaseMaintenanceLease({ env: f.env }, async () => {
            const opened = new DatabaseSync(f.databasePath);
            try {
              await migrateCanonicalTranscriptArchives({
                agentId: "main",
                database: opened,
                pathname: f.databasePath,
                start: { generation: "", sessionId: "" },
                transformContent: (content) => ({ changed: false, content }),
                writeCursor: (cursor) => {
                  opened
                    .prepare(`INSERT INTO schema_meta
                (meta_key, role, agent_id, schema_version, app_version, created_at, updated_at)
                VALUES ('archive-test-cursor', 'agent', 'main', 1, ?, 1, 1)`)
                    .run(JSON.stringify(cursor));
                  rejectCommit = true;
                },
              });
            } finally {
              clearNodeSqliteKyselyCacheForDatabase(opened);
              opened.close();
            }
          }),
        ),
      ).rejects.toThrow("failed to verify agent database maintenance lease");
    } finally {
      await scope.close();
    }
    const reopened = new DatabaseSync(f.databasePath, { readOnly: true });
    try {
      expect(
        reopened.prepare("SELECT 1 FROM schema_meta WHERE meta_key = 'archive-test-cursor'").get(),
      ).toBeUndefined();
    } finally {
      reopened.close();
    }
  });

  it("seeks across archive batches without skipping retained generations", async () => {
    const f = fixture({ fileContent: null });
    const { DatabaseSync } = requireNodeSqlite();
    const database = new DatabaseSync(f.databasePath);
    try {
      const insert = database.prepare(`INSERT INTO session_transcript_archives(
          session_id,generation,session_key,reason,encoding,archive_blob,archive_sha256,
          archive_name,created_at,published_at)
        SELECT ?, ?, session_key, reason, encoding, archive_blob, archive_sha256,
          ?, created_at, published_at FROM session_transcript_archives
        WHERE session_id = ? AND generation = ?`);
      database.exec("BEGIN");
      for (const session of ["a", "b", "c"]) {
        for (let index = 0; index < 40; index++) {
          const retained = String(index).padStart(3, "0");
          insert.run(session, retained, `${session}-${retained}.jsonl`, sessionId, generation);
        }
      }
      database.exec("COMMIT");
    } finally {
      database.close();
    }
    // oxlint-disable-next-line typescript/unbound-method -- called below with the intercepted database receiver.
    const prepare = DatabaseSync.prototype.prepare;
    const plans: string[] = [];
    const observed = vi.spyOn(DatabaseSync.prototype, "prepare").mockImplementation(function (
      this: DatabaseSync,
      sql,
    ) {
      if (
        /^select .*archive_blob.* from "session_transcript_archives" where .* order by /i.test(sql)
      ) {
        const bindings = Array.from({ length: (sql.match(/\?/g) ?? []).length }, () => "");
        plans.push(
          ...prepare
            .call(this, `EXPLAIN QUERY PLAN ${sql}`)
            .all(...bindings)
            .map((row) => String(row.detail)),
        );
      }
      return prepare.call(this, sql);
    });
    const result = await migrateLegacyMediaPersistence({ env: f.env }).finally(() =>
      observed.mockRestore(),
    );
    expect(result.warningDisposition).toBe("recoverable");
    expect(result.warnings).toHaveLength(6);
    expect(result.warnings[0]).toContain("Missing 121 canonical transcript archive file(s)");
    expect(result.warnings[0]).toContain("showing 5 example(s), 116 omitted");
    expect(result.warnings.slice(1)).toEqual(
      ["000", "001", "002", "003", "004"].map(
        (retained) =>
          `Missing canonical transcript archive copy: ${path.join(f.archiveDirectory, `a-${retained}.jsonl`)}`,
      ),
    );
    expect(plans.length).toBeGreaterThan(0);
    // A page must seek both parts of the existing archive key, not rescan its visited prefix.
    expect(
      plans.every(
        (detail) =>
          detail.startsWith("SEARCH ") &&
          detail.includes("session_id") &&
          detail.includes("generation"),
      ),
    ).toBe(true);
    const migrated = new DatabaseSync(f.databasePath, { readOnly: true });
    try {
      const rows = migrated
        .prepare("SELECT * FROM session_transcript_archives ORDER BY session_id,generation")
        .all() as ArchiveRow[];
      expect(rows).toHaveLength(121);
      for (const row of rows) {
        expectCanonical(row);
      }
      expect(rows.filter((row) => row.session_id === "b").map((row) => row.generation)).toEqual(
        Array.from({ length: 40 }, (_, index) => String(index).padStart(3, "0")),
      );
    } finally {
      migrated.close();
    }
    expect(await migrateLegacyMediaPersistence({ env: f.env })).toEqual({
      changes: [],
      warnings: result.warnings,
      warningDisposition: "recoverable",
    });
  });

  it.each(["identity", "zstd"] as const)(
    "converges the %s blob, digest and published file without changing archive identity",
    async (encoding) => {
      const f = fixture({ encoding });
      const before = f.read();
      const result = await migrateLegacyMediaPersistence({ env: f.env });
      expect(result.warnings).toEqual([]);
      const after = f.read();
      expectCanonical(after);
      expectPreservedIdentity(before, after);
      expect(after.published_at).toBe(publishedAt);
      expect(fs.readFileSync(f.archivePath)).toEqual(Buffer.from(after.archive_blob));
      expect(
        publishEncodedSessionTranscriptArchive({
          archiveDirectory: f.archiveDirectory,
          archiveName: after.archive_name,
          bytes: Buffer.from(after.archive_blob),
          sha256: after.archive_sha256,
        }),
      ).toBe(f.archivePath);

      expect(await migrateLegacyMediaPersistence({ env: f.env })).toEqual({
        changes: [],
        warnings: [],
      });
      expect(f.read()).toEqual(after);
      expect(fs.readFileSync(f.archivePath)).toEqual(Buffer.from(after.archive_blob));
    },
  );

  it("warns about an absent archive copy while normalizing its blob and leaving publication pending", async () => {
    const f = fixture({ fileContent: null });
    const before = f.read();
    const result = await migrateLegacyMediaPersistence({ env: f.env });
    expect(result.warningDisposition).toBe("recoverable");
    expect(result.warnings).toHaveLength(2);
    expect(result.warnings[0]).toContain("Missing 1 canonical transcript archive file(s)");
    expect(result.warnings[1]).toBe(`Missing canonical transcript archive copy: ${f.archivePath}`);
    const after = f.read();
    expectCanonical(after);
    expectPreservedIdentity(before, after);
    expect(after.published_at).toBeNull();
    expect(fs.existsSync(f.archivePath)).toBe(false);
    expect(await migrateLegacyMediaPersistence({ env: f.env })).toEqual({
      changes: [],
      warnings: result.warnings,
      warningDisposition: "recoverable",
    });
    expect(f.read()).toEqual(after);
    expect(fs.existsSync(f.archivePath)).toBe(false);
  });

  it("reports missing copies before completing the historical directive cursor", async () => {
    const f = fixture({ content: canonicalContent, fileContent: null });
    const before = f.read();
    const result = await migrateHistoricalTranscriptDirectives({ env: f.env });
    expect(result).toMatchObject({ changes: [], warningDisposition: "recoverable" });
    expect(result.warnings).toEqual([
      expect.stringContaining("Missing 1 canonical transcript archive file(s)"),
      `Missing canonical transcript archive copy: ${f.archivePath}`,
    ]);
    expect(f.read()).toEqual(before);
    expect(fs.existsSync(f.archivePath)).toBe(false);
    expect(await migrateHistoricalTranscriptDirectives({ env: f.env })).toEqual({
      changes: [],
      warnings: [],
    });
  });

  it("repairs a legacy blob after an earlier migration changed only its file", async () => {
    const f = fixture({ fileContent: canonicalContent });
    const repairedFile = fs.readFileSync(f.archivePath);
    expect((await migrateLegacyMediaPersistence({ env: f.env })).warnings).toEqual([]);
    const after = f.read();
    expectCanonical(after);
    expect(fs.readFileSync(f.archivePath)).toEqual(repairedFile);
    expect(Buffer.from(after.archive_blob)).toEqual(repairedFile);
  });

  it.each([
    ["stale", legacyContent],
    ["corrupt", "{broken archive\n"],
  ])("recovers a %s file from an already canonical blob", async (_label, fileContent) => {
    const f = fixture({ content: canonicalContent, fileContent });
    const before = f.read();
    expect((await migrateLegacyMediaPersistence({ env: f.env })).warnings).toEqual([]);
    expectCanonical(f.read());
    expect(Buffer.from(f.read().archive_blob)).toEqual(Buffer.from(before.archive_blob));
    expect(fs.readFileSync(f.archivePath)).toEqual(Buffer.from(before.archive_blob));
  });

  it.each([
    { failure: "digest", digest: "0".repeat(64), content: legacyContent },
    { failure: "JSON", content: "{broken canonical archive\n" },
  ])("preserves an owned file when its canonical $failure is invalid", async (options) => {
    const f = fixture({ ...options, fileContent: legacyContent });
    const before = f.read();
    const ownedFile = fs.readFileSync(f.archivePath);
    const result = await migrateLegacyMediaPersistence({ env: f.env });
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(f.read()).toEqual(before);
    // Falling through to the standalone legacy-file pass would silently mutate this file.
    expect(fs.readFileSync(f.archivePath)).toEqual(ownedFile);
  });

  it("keeps a verified canonical archive byte-identical", async () => {
    const content = ` ${JSON.stringify(canonicalEvent)} \n ${JSON.stringify(preservedEvent)} `;
    const f = fixture({ content });
    const before = f.read();
    expect(await migrateLegacyMediaPersistence({ env: f.env })).toEqual({
      changes: [],
      warnings: [],
    });
    expect(f.read()).toEqual(before);
    expect(fs.readFileSync(f.archivePath)).toEqual(Buffer.from(before.archive_blob));
  });

  it("accepts a current-schema database without the optional archive table", async () => {
    const stateDir = makeTempDir(tempDirs, "media-without-canonical-archives-");
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const opened = openOpenClawAgentDatabase({ agentId: "main", env });
    const databasePath = opened.path;
    // Historical same-version databases may predate the lazy archive table.
    opened.db.exec("DROP TABLE IF EXISTS session_transcript_archives");
    closeOpenClawAgentDatabasesForTest();
    expect(await migrateLegacyMediaPersistence({ env })).toEqual({
      changes: [],
      warnings: [],
    });
    const { DatabaseSync } = requireNodeSqlite();
    const database = new DatabaseSync(databasePath, { readOnly: true });
    try {
      expect(
        database
          .prepare("SELECT name FROM sqlite_schema WHERE name = 'session_transcript_archives'")
          .get(),
      ).toBeUndefined();
    } finally {
      database.close();
    }
  });

  it("retains a normalized pending blob after publication fails and recovers on the next pass", async () => {
    const f = fixture();
    const originalFile = fs.readFileSync(f.archivePath);
    const renameSync = fs.renameSync;
    let failed = false;
    const rename = vi.spyOn(fs, "renameSync").mockImplementation((source, destination) => {
      if (!failed && destination === f.archivePath) {
        failed = true;
        throw new Error("synthetic archive publication failure");
      }
      return renameSync(source, destination);
    });
    const result = await migrateLegacyMediaPersistence({ env: f.env }).finally(() => {
      rename.mockRestore();
    });
    expect(failed).toBe(true);
    expect(result.warnings.join("\n")).toContain("synthetic archive publication failure");
    const pending = f.read();
    expectCanonical(pending);
    expect(pending.published_at).toBeNull();
    // A second standalone attempt would succeed after the one-shot failure and violate this state.
    expect(fs.readFileSync(f.archivePath)).toEqual(originalFile);

    expect((await migrateLegacyMediaPersistence({ env: f.env })).warnings).toEqual([]);
    expectCanonical(f.read());
    expect(fs.readFileSync(f.archivePath)).toEqual(Buffer.from(pending.archive_blob));
  });
});
