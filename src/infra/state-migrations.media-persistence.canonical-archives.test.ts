import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
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
} from "../config/sessions/session-accessor.sqlite-archive.js";
import { resolveSqliteTranscriptArchiveDirectory } from "../config/sessions/session-accessor.sqlite-scope.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import { ensureSessionTranscriptArchiveSchema } from "../state/openclaw-agent-session-transcript-archive-schema.js";
import { requireNodeSqlite } from "./node-sqlite.js";
import { migrateLegacyMediaPersistence } from "./state-migrations.media-persistence.js";
import { cleanupMediaPersistenceFixtures } from "./state-migrations.media-persistence.test-support.js";

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

afterEach(() => {
  vi.restoreAllMocks();
  cleanupMediaPersistenceFixtures(tempDirs);
});

describe("media migration of canonical SQLite transcript archives", () => {
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

  it("normalizes an archive with an absent file and leaves publication pending", async () => {
    const f = fixture({ fileContent: null });
    const before = f.read();
    expect((await migrateLegacyMediaPersistence({ env: f.env })).warnings).toEqual([]);
    const after = f.read();
    expectCanonical(after);
    expectPreservedIdentity(before, after);
    expect(after.published_at).toBeNull();
    expect(fs.existsSync(f.archivePath)).toBe(false);
    expect(await migrateLegacyMediaPersistence({ env: f.env })).toEqual({
      changes: [],
      warnings: [],
    });
    expect(f.read()).toEqual(after);
    expect(fs.existsSync(f.archivePath)).toBe(false);
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
