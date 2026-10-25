import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { zstdCompressSync } from "node:zlib";
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
import { withAgentDatabaseMaintenanceLease } from "../state/openclaw-agent-db-maintenance-lease.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import { ensureSessionTranscriptArchiveSchema } from "../state/openclaw-agent-session-transcript-archive-schema.js";
import { requireNodeSqlite } from "./node-sqlite.js";
import { withSqliteReadOnlyWorkerScope } from "./sqlite-readonly-worker.js";
import { transformMediaArchiveContent } from "./state-migrations.media-persistence-transform.js";
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
  ...legacyEvent,
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

const openDatabase = (pathname: string, readOnly = false) =>
  new (requireNodeSqlite().DatabaseSync)(pathname, { readOnly });

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
    using database = openDatabase(databasePath, true);
    return database
      .prepare("SELECT * FROM session_transcript_archives WHERE session_id = ? AND generation = ?")
      .get(sessionId, generation) as ArchiveRow;
  };
  const recoveryDirectories = () =>
    fs
      .readdirSync(path.dirname(databasePath))
      .filter((name) => name.startsWith("openclaw-media-persistence-recovery-"));
  return {
    archiveDirectory,
    archiveName,
    archivePath,
    databasePath,
    env,
    read,
    recoveryDirectories,
  };
}

function archiveCloner(database: DatabaseSync) {
  const insert = database.prepare(`INSERT INTO session_transcript_archives(
    session_id,generation,session_key,reason,encoding,archive_blob,archive_sha256,
    archive_name,created_at,published_at)
    SELECT ?,?,session_key,reason,encoding,archive_blob,archive_sha256,?,created_at,published_at
    FROM session_transcript_archives WHERE session_id = ? AND generation = ?`);
  return (id: string, retained = generation, name = `${id}.jsonl`) =>
    insert.run(id, retained, name, sessionId, generation);
}
function expectNoChanges(result: { changes: string[]; warnings: string[] }) {
  expect(result).toEqual({ changes: [], warnings: [] });
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
  const identity = ({
    archive_blob: _blob,
    archive_sha256: _hash,
    published_at: _published,
    ...rest
  }: ArchiveRow) => rest;
  expect(identity(after)).toEqual(identity(before));
}

afterEach(() => {
  vi.restoreAllMocks();
  cleanupMediaPersistenceFixtures(tempDirs);
});

describe("media migration of canonical SQLite transcript archives", () => {
  it.each(["identity", "zstd"] as const)(
    "warns and preserves malformed UTF-8 in a %s archive and its published copy",
    async (encoding) => {
      const f = fixture({ encoding });
      const malformed = Buffer.from(legacyContent);
      malformed[malformed.indexOf("keep the attachment")] = 0xff;
      const bytes = encoding === "zstd" ? zstdCompressSync(malformed) : malformed;
      {
        using database = openDatabase(f.databasePath);
        database
          .prepare("UPDATE session_transcript_archives SET archive_blob = ?, archive_sha256 = ?")
          .run(bytes, sha256(bytes));
      }
      fs.writeFileSync(f.archivePath, bytes);
      const before = f.read();

      const result = await migrateLegacyMediaPersistence({ env: f.env });

      expect(result.changes).toEqual([]);
      expect(result.warnings.join("\n")).toContain("must be valid UTF-8");
      expect(result.warningDisposition).toBe("recoverable");
      const directives = await migrateHistoricalTranscriptDirectives({ env: f.env });
      expect(directives.warnings.join("\n")).toContain("must be valid UTF-8");
      expect(directives.warningDisposition).toBe("recoverable");
      expect(f.read()).toEqual(before);
      expect(fs.readFileSync(f.archivePath)).toEqual(bytes);
    },
  );

  it.each([
    {
      label: "media",
      migrate: migrateLegacyMediaPersistence,
      entry: "migrateCanonicalTranscriptArchives",
    },
    {
      label: "directives",
      migrate: migrateHistoricalTranscriptDirectives,
      entry: "migrateTranscriptDirectiveArchives",
    },
  ] as const)(
    "preserves archive interruption through the $label migration owner",
    async ({ migrate, entry }) => {
      const f = fixture({ content: canonicalContent });
      const controller = new AbortController();
      const interrupted = new Error("Doctor interrupted by SIGINT");
      const archives = await import("./state-migrations.transcript-directives-archives.js");
      vi.spyOn(archives, entry).mockImplementation(async () => {
        controller.abort(interrupted);
        throw interrupted;
      });
      await expect(
        withSqliteReadOnlyWorkerScope(() => migrate({ env: f.env }), {
          signal: controller.signal,
          deadlineOwnedByCaller: true,
        }),
      ).rejects.toBe(interrupted);
    },
  );

  it("verifies 200 unchanged archives without taking an archive write lock", async () => {
    const f = fixture({ content: canonicalContent });
    using database = openDatabase(f.databasePath);
    const clone = archiveCloner(database);
    for (let index = 1; index < 200; index++) {
      const name = `canonical-${index}.jsonl`;
      clone(`canonical-${index}`, generation, name);
      fs.writeFileSync(path.join(f.archiveDirectory, name), canonicalContent);
    }
    await withAgentDatabaseMaintenanceLease({ env: f.env, processBound: true }, async () => {
      const exec = database.exec.bind(database);
      const transactions = vi.spyOn(database, "exec").mockImplementation((sql) => {
        expect(sql).not.toMatch(/BEGIN IMMEDIATE/i);
        return exec(sql);
      });
      const started = performance.now();
      const result = await migrateCanonicalTranscriptArchives({
        agentId: "main",
        database,
        pathname: f.databasePath,
        start: { generation: "", sessionId: "" },
        transformLine: transformMediaArchiveContent,
      });
      const elapsed = performance.now() - started;
      expect(result).toEqual({ rewrittenArchives: 0, warnings: [] });
      expect(transactions.mock.calls.filter(([sql]) => /BEGIN IMMEDIATE/i.test(sql))).toEqual([]);
      expect(elapsed).toBeLessThan(1_000);
      transactions.mockRestore();
    });
  });

  it("seeks across archive batches without skipping retained generations", async () => {
    const f = fixture({ fileContent: null });
    const { DatabaseSync } = requireNodeSqlite();
    {
      using database = openDatabase(f.databasePath);
      const clone = archiveCloner(database);
      database.exec("BEGIN");
      for (const session of ["a", "b", "c"]) {
        for (let index = 0; index < 40; index++) {
          const retained = String(index).padStart(3, "0");
          clone(session, retained, `${session}-${retained}.jsonl`);
        }
      }
      database.exec("COMMIT");
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
    {
      using database = openDatabase(f.databasePath, true);
      const rows = database
        .prepare("SELECT * FROM session_transcript_archives ORDER BY session_id,generation")
        .all() as ArchiveRow[];
      expect(rows).toHaveLength(121);
      for (const row of rows) {
        expectCanonical(row);
      }
      expect(rows.filter((row) => row.session_id === "b").map((row) => row.generation)).toEqual(
        Array.from({ length: 40 }, (_, index) => String(index).padStart(3, "0")),
      );
    }
    expect(await migrateLegacyMediaPersistence({ env: f.env })).toEqual({
      changes: [],
      warnings: result.warnings,
      warningDisposition: "recoverable",
    });
  });

  it.each([
    ["zstd", "zstd", legacyContent, legacyContent],
    ["already repaired file", "identity", legacyContent, canonicalContent],
  ] as const)(
    "converges the %s blob, digest and published file without changing archive identity",
    async (_label, encoding, content, fileContent) => {
      const f = fixture({ encoding, content, fileContent });
      const before = f.read();
      const originalFile = fs.readFileSync(f.archivePath);
      const result = await migrateLegacyMediaPersistence({ env: f.env });
      expect(result.warnings).toEqual([]);
      const backups = f.recoveryDirectories();
      expect(backups).toHaveLength(1);
      {
        using database = openDatabase(
          path.join(path.dirname(f.databasePath), backups[0]!, "database.sqlite"),
          true,
        );
        expect(database.prepare("SELECT * FROM session_transcript_archives").get()).toEqual(before);
      }
      const after = f.read();
      expectCanonical(after);
      expectPreservedIdentity(before, after);
      expect(after.published_at).toBe(publishedAt);
      expect(fs.readFileSync(f.archivePath)).toEqual(Buffer.from(after.archive_blob));
      if (fileContent === canonicalContent) {
        expect(fs.readFileSync(f.archivePath)).toEqual(originalFile);
        expect(Buffer.from(after.archive_blob)).toEqual(originalFile);
      }
      expect(
        publishEncodedSessionTranscriptArchive({
          archiveDirectory: f.archiveDirectory,
          archiveName: after.archive_name,
          bytes: Buffer.from(after.archive_blob),
          sha256: after.archive_sha256,
        }),
      ).toBe(f.archivePath);

      expectNoChanges(await migrateLegacyMediaPersistence({ env: f.env }));
      expect(f.read()).toEqual(after);
      expect(fs.readFileSync(f.archivePath)).toEqual(Buffer.from(after.archive_blob));
      expect(f.recoveryDirectories()).toEqual(backups);
    },
  );

  it("reports an absent archive copy during historical directives migration", async () => {
    const f = fixture({ content: canonicalContent, fileContent: null });
    const before = f.read();
    const result = await migrateHistoricalTranscriptDirectives({ env: f.env });
    expect(result.warningDisposition).toBe("recoverable");
    expect(result.warnings).toEqual([
      expect.stringContaining("Missing 1 canonical transcript archive file(s)"),
      `Missing canonical transcript archive copy: ${f.archivePath}`,
    ]);
    expect(result.changes).toEqual([]);
    expect(f.read()).toEqual(before);
    expect(fs.existsSync(f.archivePath)).toBe(false);
    expectNoChanges(await migrateHistoricalTranscriptDirectives({ env: f.env }));
    expect(f.read()).toEqual(before);
    expect(fs.existsSync(f.archivePath)).toBe(false);
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

  it("repairs earlier archives before reporting an unreadable later copy", async () => {
    const f = fixture();
    const deniedPath = path.join(f.archiveDirectory, "z-denied.jsonl");
    {
      using database = openDatabase(f.databasePath);
      archiveCloner(database)("z-denied");
    }
    fs.writeFileSync(deniedPath, legacyContent);
    const readFileSync = fs.readFileSync;
    const reads = vi.spyOn(fs, "readFileSync").mockImplementation((file, options) => {
      if (file === deniedPath) {
        throw Object.assign(new Error("synthetic unreadable archive copy"), { code: "EACCES" });
      }
      return readFileSync(file, options);
    });
    const result = await migrateLegacyMediaPersistence({ env: f.env }).finally(() =>
      reads.mockRestore(),
    );
    expect(result.warnings.join("\n")).toContain("synthetic unreadable archive copy");
    expect(
      f.read().archive_sha256,
      "earlier archive must commit before a later unreadable copy",
    ).toBe(sha256(Buffer.from(canonicalContent)));
    expectCanonical(f.read());
    expect(fs.readFileSync(f.archivePath)).toEqual(Buffer.from(canonicalContent));
  });

  it("keeps a verified canonical archive byte-identical", async () => {
    const content = ` ${JSON.stringify(canonicalEvent)} \n ${JSON.stringify(preservedEvent)} `;
    const f = fixture({ content });
    const before = f.read();
    expectNoChanges(await migrateLegacyMediaPersistence({ env: f.env }));
    expect(f.read()).toEqual(before);
    expect(fs.readFileSync(f.archivePath)).toEqual(Buffer.from(before.archive_blob));
    expect(f.recoveryDirectories()).toEqual([]);

    const reads = vi.spyOn(fs, "readFileSync");
    expectNoChanges(await migrateLegacyMediaPersistence({ env: f.env }));
    expect(reads.mock.calls.filter(([file]) => file === f.archivePath)).toEqual([]);
    reads.mockRestore();

    // A restored legacy copy invalidates the fact even at the same application version.
    fs.writeFileSync(f.archivePath, legacyContent);
    expect((await migrateLegacyMediaPersistence({ env: f.env })).warnings).toEqual([]);
    expect(fs.readFileSync(f.archivePath)).toEqual(Buffer.from(before.archive_blob));

    {
      using database = openDatabase(f.databasePath);
      const bytes = Buffer.from(legacyContent);
      database
        .prepare("UPDATE session_transcript_archives SET archive_blob = ?, archive_sha256 = ?")
        .run(bytes, sha256(bytes));
    }
    expect((await migrateLegacyMediaPersistence({ env: f.env })).warnings).toEqual([]);
    expectCanonical(f.read());
    {
      using database = openDatabase(f.databasePath);
      database
        .prepare("UPDATE session_transcript_archives SET archive_blob = ?")
        .run(Buffer.from("corrupt"));
    }
    expect((await migrateLegacyMediaPersistence({ env: f.env })).warnings.join("\n")).toContain(
      "Canonical SQLite transcript archive is corrupt",
    );
  });

  it("accepts a current-schema database without the optional archive table", async () => {
    const stateDir = makeTempDir(tempDirs, "media-without-canonical-archives-");
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const opened = openOpenClawAgentDatabase({ agentId: "main", env });
    const databasePath = opened.path;
    // Historical same-version databases may predate the lazy archive table.
    opened.db.exec("DROP TABLE IF EXISTS session_transcript_archives");
    closeOpenClawAgentDatabasesForTest();
    expectNoChanges(await migrateLegacyMediaPersistence({ env }));
    {
      using database = openDatabase(databasePath, true);
      expect(
        database
          .prepare("SELECT name FROM sqlite_schema WHERE name = 'session_transcript_archives'")
          .get(),
      ).toBeUndefined();
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
