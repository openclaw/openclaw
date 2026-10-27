import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { Compilable } from "kysely";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { safeTranscriptPathSegment } from "../transcripts/store-artifacts.js";
import { TranscriptsStore } from "../transcripts/store.js";
import { summarizeTranscripts } from "../transcripts/summary.js";
import { executeSqliteQuerySync } from "./kysely-sync.js";
import { withGatewayLockHeld } from "./state-migrations.gateway-lock.test-support.js";
import { migrationDb } from "./state-migrations.meeting-transcripts-database.js";
import { restoreCanonicalMeetingTranscriptExports } from "./state-migrations.meeting-transcripts-files.js";
import {
  detectLegacyMeetingTranscripts,
  migrateLegacyMeetingTranscripts,
} from "./state-migrations.meeting-transcripts.js";

async function expectFile(file: string, contents: string) {
  await expect(fs.readFile(file, "utf8")).resolves.toBe(contents);
}

async function expectExists(...files: string[]) {
  for (const file of files) {
    await expect(fs.stat(file)).resolves.toBeDefined();
  }
}

async function expectMissing(file: string) {
  await expect(fs.stat(file)).rejects.toMatchObject({ code: "ENOENT" });
}

async function mkdir(...parts: string[]) {
  const dir = path.join(...parts);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

async function closeDatabase() {
  await closeOpenClawStateDatabaseAsync();
  closeOpenClawStateDatabaseForTest();
}

function jsonLines(body: string) {
  return body
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
}

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const date = "2026-07-01";
const migrationTime = "2026-07-02T00-00-00-000Z";
const migrationNow = () => Date.parse("2026-07-02T00:00:00.000Z");

afterEach(closeDatabase);

type LegacyOptions = {
  invalidTranscript?: boolean;
  utteranceCount?: number;
  emptyMarkdown?: boolean;
  omitSummaryJson?: boolean;
};

async function seedLegacySession(stateDir: string, sessionId: string, options: LegacyOptions = {}) {
  const sessionDir = await mkdir(stateDir, "transcripts", date, sessionId);
  const write = (name: string, data: unknown) =>
    fs.writeFile(path.join(sessionDir, name), JSON.stringify(data) + "\n");
  const session = {
    sessionId,
    title: "Design review",
    source: { providerId: "manual-transcript", meetingUrl: "https://meet.example.invalid/room" },
    startedAt: `${date}T10:00:00.000Z`,
    stoppedAt: `${date}T10:30:00.000Z`,
  };
  await write("metadata.json", session);
  const utterances = Array.from({ length: options.utteranceCount ?? 2 }, (_, index) => ({
    id: `u-${index + 1}`,
    sessionId,
    speaker: { label: index % 2 === 0 ? "Alex" : "Sam" },
    text: index === 0 ? "First line" : index === 1 ? "Second line" : `Line ${index + 1}`,
    final: true,
  }));
  await fs.writeFile(
    path.join(sessionDir, "transcript.jsonl"),
    options.invalidTranscript
      ? "{invalid\n"
      : utterances.map((line) => JSON.stringify(line)).join("\n") + "\n",
  );
  if (!options.omitSummaryJson) {
    await write("summary.json", {
      ...summarizeTranscripts({ session, utterances }),
      generatedAt: `${date}T10:31:00.000Z`,
    });
  }
  await fs.writeFile(
    path.join(sessionDir, "summary.md"),
    options.emptyMarkdown ? "" : "# Design review\n\nFirst line.\n",
  );
  return sessionDir;
}

function harness() {
  const stateDir = tempDirs.make("openclaw-meeting-transcripts-doctor-");
  const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
  const root = path.join(stateDir, "transcripts");
  const detect = () =>
    detectLegacyMeetingTranscripts({ stateDir, env, doctorOnlyStateMigrations: true });
  const database = () => openOpenClawStateDatabase({ env }).db;
  const store = new TranscriptsStore(root, { env });
  return {
    stateDir,
    env,
    root,
    detect,
    store,
    sessionPath: (id: string, day = date) => path.join(root, day, id),
    archivePath: (kind = "migrated") => `${root}.${kind}-${migrationTime}`,
    async native(sessionId: string, text?: string) {
      const session = nativeSession(sessionId);
      await store.writeSession(session);
      if (text !== undefined) {
        await store.appendUtteranceForSession(session, { text });
      }
      const artifacts = await store.materializeSessionArtifacts(
        session,
        text === undefined ? "metadata" : "transcript",
      );
      return { session, artifacts };
    },
    database,
    expectEmpty(table: "meeting_transcript_sessions" | "migration_sources") {
      expect(database().prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()).toEqual({
        count: 0,
      });
    },
    restore(archiveRoot: string, relativeDir: string) {
      return restoreCanonicalMeetingTranscriptExports({
        sourceRoot: root,
        archiveRoot,
        migratedSourcePaths: [],
        canonicalRelativeDirs: [relativeDir],
      });
    },
    snapshot: () => {
      const db = database();
      const q = migrationDb(db);
      const rows = <T>(query: Compilable<T>) => executeSqliteQuerySync(db, query).rows;
      return {
        sessions: rows(
          q.selectFrom("meeting_transcript_sessions").selectAll().orderBy("session_id"),
        ),
        utterances: rows(
          q
            .selectFrom("meeting_transcript_utterances")
            .selectAll()
            .orderBy("session_id")
            .orderBy("sequence"),
        ),
        summaries: rows(
          q.selectFrom("meeting_transcript_summaries").selectAll().orderBy("session_id"),
        ),
        runs: rows(q.selectFrom("migration_runs").selectAll().orderBy("id")),
        sources: rows(q.selectFrom("migration_sources").selectAll().orderBy("source_key")),
      };
    },
    seed: (sessionId: string, options?: LegacyOptions) =>
      seedLegacySession(stateDir, sessionId, options),
    migrate: (
      options: Pick<
        Parameters<typeof migrateLegacyMeetingTranscripts>[0],
        "detected" | "now" | "testHooks"
      > = {},
    ) =>
      migrateLegacyMeetingTranscripts({
        stateDir,
        env,
        ...options,
        detected: options.detected ?? detect(),
      }),
  };
}

function nativeSession(sessionId: string, day = "2026-07-02") {
  return {
    sessionId,
    source: { providerId: "manual-transcript" },
    startedAt: `${day}T10:00:00.000Z`,
  };
}

function interrupt() {
  throw new Error("interrupted");
}

const unix = process.platform !== "win32";
let h: ReturnType<typeof harness>;
beforeEach(() => {
  h = harness();
});

async function migrateClean(options?: Parameters<typeof h.migrate>[0]) {
  const result = await h.migrate(options);
  expect(result.warnings).toEqual([]);
  return result;
}

function expectImported(snapshot: ReturnType<typeof h.snapshot>, sessionId: string) {
  expect(snapshot).toMatchObject({
    sessions: [{ session_id: sessionId }],
    runs: [{ status: "imported", finished_at: null }],
    sources: [{ status: "imported", removed_source: 0 }],
  });
  expect(snapshot.utterances).toHaveLength(2);
  expect(snapshot.summaries).toHaveLength(1);
}

it.runIf(unix).each([
  ["root", [], "regular directory"],
  ["date", ["2026-07-01"], "cannot be a symlink"],
  ["session", ["2026-07-01", "linked-session"], "cannot be a symlink"],
  ["partial artifact", ["2026-07-01", "partial-invalid", "transcript.jsonl"], "regular file"],
] as const)("rejects a symlinked %s before moving any source", async (_kind, parts, error) => {
  const external = tempDirs.make("openclaw-meeting-transcripts-external-");
  const target = path.join(h.root, ...parts);
  await mkdir(path.dirname(target));
  const isFile = parts.at(-1) === "transcript.jsonl";
  const source = isFile ? path.join(external, "transcript.jsonl") : external;
  if (isFile) {
    await fs.writeFile(source, '{"text":"outside"}\n');
    await fs.writeFile(path.join(path.dirname(target), "summary.md"), "keep me\n");
  }
  await fs.symlink(source, target, isFile ? undefined : "dir");
  expect(() => h.detect()).toThrow(error);
  if (isFile) {
    await expectFile(path.join(path.dirname(target), "summary.md"), "keep me\n");
  }
});

it.each(["metadata.json", "transcript.jsonl", "summary.json", "summary.md"])(
  "preserves malformed UTF-8 %s without importing replacement characters",
  async (fileName) => {
    const source = await h.seed("invalid-utf8", {
      utteranceCount: fileName === "transcript.jsonl" ? 1_003 : 2,
    });
    const file = path.join(source, fileName);
    const original = await fs.readFile(file);
    const malformed = Buffer.from(original);
    const marker = fileName === "transcript.jsonl" ? "Line 1003" : "Design review";
    const offset = malformed.lastIndexOf(marker);
    expect(offset).toBeGreaterThan(-1);
    malformed[offset] = 0xff;
    await fs.writeFile(file, malformed);

    const result = await h.migrate();

    expect(result.changes).toEqual([]);
    expect(result.warnings.join("\n")).toContain(`${file} must be valid UTF-8`);
    expect(result.warningDisposition).toBe("recoverable");
    await expect(fs.readFile(file)).resolves.toEqual(malformed);
    h.expectEmpty("meeting_transcript_sessions");
    h.expectEmpty("migration_sources");
    await fs.writeFile(file, original);
    expect((await h.migrate()).warnings).toEqual([]);
    const session = await h.store.readSession("invalid-utf8");
    expect(session).toBeDefined();
    if (fileName === "transcript.jsonl") {
      const utterances = await h.store.readUtterancesForSession(session!);
      expect(utterances).toHaveLength(1_003);
      expect(utterances[0]).toMatchObject({ id: "u-1", text: "First line" });
      expect(utterances.at(-1)).toMatchObject({ id: "u-1003", text: "Line 1003" });
    }
  },
);

it("imports shipped dot-only session layouts into reserved SQLite selectors", async () => {
  for (const sessionId of [".", "..", "session"]) {
    await h.seed(sessionId, { emptyMarkdown: true, omitSummaryJson: true });
  }
  const detected = h.detect();
  expect(detected.hasLegacy).toBe(true);

  await migrateClean({ detected });
  const expectedSlugs = [
    [".", "%2E"],
    ["..", "%2E%2E"],
    ["session", "session"],
  ] as const;
  for (const [sessionId, expectedSlug] of expectedSlugs) {
    const session = await h.store.readSession(sessionId);
    expect(session?.sessionId).toBe(sessionId);
    expect(h.store.sessionDir(session!)).toBe(path.join(h.root, "2026-07-01", expectedSlug));
    const artifacts = await h.store.materializeSessionArtifacts(session!, "transcript");
    const lines = jsonLines(await fs.readFile(artifacts.transcriptPath, "utf8"));
    expect(lines.map((line) => line.text)).toEqual(["First line", "Second line"]);
    await expect(h.store.readSummary(session!)).resolves.toEqual({ markdown: "" });
  }
});

it.runIf(process.platform !== "win32" && process.platform !== "darwin")(
  "imports case-distinct sessions from a case-sensitive legacy tree",
  async () => {
    await h.seed("Capital");
    await h.seed("capital");

    await migrateClean();
    const upper = (await h.store.readSession("2026-07-01/Capital"))!;
    const lower = (await h.store.readSession("2026-07-01/capital"))!;
    expect(upper).toMatchObject({ sessionId: "Capital" });
    expect(lower).toMatchObject({ sessionId: "capital" });
    const upperArtifacts = await h.store.materializeSessionArtifacts(upper, "metadata");
    await h.store.materializeSessionArtifacts(lower, "metadata");
    await fs.rename(upperArtifacts.sessionDir, path.join(h.root, "2026-07-01", "CAPITAL"));
    expect(h.detect()).toMatchObject({ hasLegacy: false });
  },
);

it.each([
  ["invalid transcript", "Failed migrating meeting transcripts"],
  ["new session", "session tree changed before archive"],
] as const)("preserves sources when %s prevents completing migration", async (failure, warning) => {
  const source = await h.seed("verified");
  const other =
    failure === "invalid transcript"
      ? await h.seed("invalid", { invalidTranscript: true })
      : path.join(h.root, "2026-07-03", "late-session");
  const result = await h.migrate({
    now: migrationNow,
    testHooks:
      failure === "invalid transcript"
        ? {}
        : {
            afterImport: () => {
              fsSync.mkdirSync(other, { recursive: true });
              fsSync.writeFileSync(
                path.join(other, "metadata.json"),
                JSON.stringify(nativeSession("late-session", "2026-07-03")),
              );
            },
          },
  });
  expect(result.warnings.join("\n")).toContain(warning);
  await expectExists(source, other);
  if (failure === "invalid transcript") {
    expect(result.changes).toEqual([]);
    h.expectEmpty("meeting_transcript_sessions");
    h.expectEmpty("migration_sources");
  } else {
    expect(result.changes).toEqual([
      "Imported 1 meeting transcript session into shared SQLite state",
    ]);
    expectImported(h.snapshot(), "verified");
  }
});

it("resumes durable imported receipts after a native archive rename failure", async () => {
  const source = await h.seed("archive-retry");
  const archiveRoot = h.archivePath();
  const blocker = path.join(archiveRoot, "unrelated");
  const rename = fs.rename;
  const archive = vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
    if (from === h.root && to === archiveRoot) {
      await fs.mkdir(archiveRoot);
      await fs.writeFile(blocker, "keep");
    }
    return rename(from, to);
  });
  const failed = await h.migrate({ now: migrationNow }).finally(() => archive.mockRestore());
  expect(failed.changes).toEqual([
    "Imported 1 meeting transcript session into shared SQLite state",
  ]);
  expect(failed.warnings.join("\n")).toContain(
    "retained imported SQLite rows and source receipts for Doctor retry",
  );
  await expectExists(source);
  await expectFile(blocker, "keep");
  await closeDatabase();
  const pending = h.snapshot();
  expectImported(pending, "archive-retry");
  const runId = pending.runs[0]!.id;
  expect(JSON.parse(pending.runs[0]!.report_json)).toMatchObject({ archiveRoot });
  expect(pending.sources).toMatchObject([
    { last_run_id: runId, source_path: source, status: "imported", removed_source: 0 },
  ]);

  await fs.rm(archiveRoot, { recursive: true });
  const resumed = await migrateClean();
  expect(resumed.changes).toEqual([
    `Resumed and archived meeting transcript migration → ${archiveRoot}`,
  ]);
  await closeDatabase();
  const completed = h.snapshot();
  for (const table of ["sessions", "utterances", "summaries"] as const) {
    expect(completed[table]).toEqual(pending[table]);
  }
  expect(completed.runs).toMatchObject([{ id: runId, status: "completed" }]);
  expect(completed.runs[0]!.finished_at).not.toBeNull();
  expect(completed.sources).toMatchObject([
    { last_run_id: runId, status: "archived", removed_source: 1 },
  ]);
  await expectMissing(source);
  await expectExists(path.join(archiveRoot, "2026-07-01", "archive-retry", "metadata.json"));
});

it("detects and recovers a partial-only legacy transcript tree", async () => {
  const partialDir = await mkdir(h.root, "2026-07-01", "partial-only");
  await fs.writeFile(path.join(partialDir, "transcript.jsonl"), '{"text":"partial"}\n');
  const detected = h.detect();
  expect(detected.hasLegacy).toBe(true);

  const result = await migrateClean({
    detected,
    now: migrationNow,
  });

  expect(result.changes.join("\n")).toContain("incomplete meeting transcript directory");
  await expectMissing(path.join(partialDir, "transcript.jsonl"));
  await expectExists(
    path.join(h.archivePath("partials-recovered"), date, "partial-only", "transcript.jsonl"),
  );
});

it("restores idempotently when a canonical exporter recreated the destination", async () => {
  const archivedStateDir = tempDirs.make("openclaw-meeting-transcripts-archive-");
  const archivedSessionDir = await seedLegacySession(archivedStateDir, "recreated-export");
  const archiveRoot = path.join(archivedStateDir, "transcripts");
  const destination = h.sessionPath("recreated-export");
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.cp(archivedSessionDir, destination, { recursive: true });

  await expect(
    h.restore(archiveRoot, path.join("2026-07-01", "recreated-export")),
  ).resolves.toBeUndefined();
  await expectExists(
    ...[destination, archivedSessionDir].map((dir) => path.join(dir, "metadata.json")),
  );
});

it("rejects canonical restore paths that normalize outside their roots", async () => {
  const archiveRoot = await mkdir(h.stateDir, "transcripts.migrated-test");

  await expect(h.restore(archiveRoot, path.join("safe", "..", "..", "outside"))).rejects.toThrow(
    "escaped its root",
  );
});

it.runIf(unix)("rejects symlinked ancestors during canonical export restore", async () => {
  const archiveRoot = await mkdir(h.stateDir, "transcripts.migrated-test");
  const externalRoot = tempDirs.make("openclaw-meeting-transcripts-external-");
  await seedLegacySession(externalRoot, "linked-export");
  await fs.symlink(
    path.join(externalRoot, "transcripts", "2026-07-01"),
    path.join(archiveRoot, "2026-07-01"),
    "dir",
  );

  await expect(h.restore(archiveRoot, path.join("2026-07-01", "linked-export"))).rejects.toThrow(
    /symlink/i,
  );
});

it.each(["import", "archive"] as const)(
  "resumes an interruption after %s commit",
  async (stage) => {
    const { session: native, artifacts } = await h.native("native-export-during-resume");
    if (stage === "import") {
      await fs.appendFile(artifacts.metadataPath, " ");
    }
    await h.seed("interrupted");
    const interrupted = await h.migrate({
      testHooks: stage === "import" ? { afterImport: interrupt } : { afterArchive: interrupt },
    });
    expect(interrupted.warnings.join("\n")).toContain("interrupted");
    if (stage === "import") {
      expect(interrupted.changes.join("\n")).toContain("modified meeting transcript export");
    }
    const pending = h.detect();
    if (stage === "archive") {
      expect(pending.hasLegacy).toBe(true);
    }
    const resumed = await migrateClean({ detected: pending });
    expect(resumed.changes.join("\n")).toContain(
      stage === "import" ? "Resumed and archived" : "Finalized interrupted",
    );
    if (stage === "archive") {
      await expectExists(h.store.sessionDir(native));
      expect(
        h
          .database()
          .prepare("SELECT status, removed_source FROM migration_sources WHERE migration_kind = ?")
          .get("meeting-transcripts-files-v1"),
      ).toEqual({ status: "archived", removed_source: 1 });
    }
  },
);

it("refuses to archive a new legacy session added after a pending import", async () => {
  await h.seed("pending-original");
  await h.migrate({ testHooks: { afterImport: interrupt } });
  const lateDir = await h.seed("pending-late");

  const pending = h.detect();
  const resumed = await h.migrate({ detected: pending });

  expect(resumed.changes).toEqual([]);
  expect(resumed.warnings.join("\n")).toContain("session tree changed before archive");
  await expectExists(lateDir);
});

it("does not classify an interrupted export of an advancing transcript as legacy", async () => {
  const { session } = await h.native("advancing-export", "first");
  await h.store.appendUtteranceForSession(session, { text: "second" });

  h.database()
    .prepare("UPDATE meeting_transcript_sessions SET export_pending_json = ? WHERE session_id = ?")
    .run('["transcript.jsonl"]', session.sessionId);
  const transcriptPath = path.join(h.store.sessionDir(session), "transcript.jsonl");
  await fs.writeFile(transcriptPath, '{"text":');

  const detected = h.detect();
  expect(detected).toMatchObject({ hasLegacy: false });
  await expect(h.migrate({ detected })).resolves.toEqual({ changes: [], warnings: [] });

  await h.store.materializeSessionArtifacts(session, "transcript");
  const exported = await fs.readFile(transcriptPath, "utf8");
  expect(jsonLines(exported).map((line) => line.text)).toEqual(["first", "second"]);
});

it("migrates legacy sessions while preserving coexisting SQLite exports", async () => {
  const native = { ...nativeSession("native-export"), title: "Native export" };
  const nativeUtterance = { text: "SQLite-native line" };
  await h.store.writeSession(native);
  await h.store.appendUtteranceForSession(native, nativeUtterance);
  await h.store.writeSummary(
    summarizeTranscripts({ session: native, utterances: [nativeUtterance] }),
    native,
  );
  const artifacts = await h.store.materializeSessionArtifacts(native, "all");
  await fs.rm(artifacts.metadataPath);
  expect(h.detect()).toMatchObject({ hasLegacy: false });
  await h.seed("legacy-alongside-export");

  await migrateClean();
  await expectMissing(artifacts.metadataPath);
  await expectExists(artifacts.transcriptPath);
  await expect(h.store.readSession("native-export")).resolves.toMatchObject({
    sessionId: "native-export",
  });
  await expect(h.store.readSession("legacy-alongside-export")).resolves.toMatchObject({
    sessionId: "legacy-alongside-export",
  });
});

it("resolves a case-renamed export directory by metadata identity", async () => {
  const { session, artifacts } = await h.native("Capital", "case-stable transcript");
  const renamedDir = h.sessionPath("capital", "2026-07-02");
  const renamedMetadata = path.join(renamedDir, "METADATA.JSON");
  await fs.rename(artifacts.sessionDir, renamedDir);
  await fs.rename(path.join(renamedDir, "metadata.json"), renamedMetadata);

  expect(h.detect()).toMatchObject({ hasLegacy: false });
  await fs.rm(renamedMetadata);
  const metadataLessDetected = h.detect();
  expect(metadataLessDetected.hasLegacy).toBe(!fsSync.existsSync(artifacts.sessionDir));
  await fs.writeFile(renamedMetadata, `${JSON.stringify(session, null, 2)}\n `);
  const detected = h.detect();
  expect(detected.hasLegacy).toBe(true);

  const recovered = await migrateClean({ detected });
  expect(recovered.changes.join("\n")).toContain("modified meeting transcript export");
  await expect(h.store.readSession("2026-07-02/Capital")).resolves.toMatchObject({
    sessionId: "Capital",
  });
});
async function seedStoredSession(sessionId: string, options: { historicalSlug?: string } = {}) {
  const session = {
    ...nativeSession(sessionId, date),
    stoppedAt: "2026-07-01T10:30:00.000Z",
    source: { providerId: "manual-transcript", channelId: "room" },
    title: "Stored notes",
    metadata: { retained: true },
  };
  await h.store.writeSession(session);
  const utterance = { text: "Preserve this note.", final: true, metadata: { retained: true } };
  await h.store.appendUtteranceForSession(session, utterance);
  const summary = summarizeTranscripts({ session, utterances: [utterance] });
  await h.store.writeSummary(summary, session);
  const markdown = "# User-edited notes\n\nKeep  spacing and **formatting**.\n";
  const db = h.database();
  const queries = migrationDb(db);
  executeSqliteQuerySync(
    db,
    queries
      .updateTable("meeting_transcript_summaries")
      .set({ markdown })
      .where("session_id", "=", sessionId),
  );
  if (options.historicalSlug) {
    // Model the old durable projection without creating an impossible filename.
    const selector = `2026-07-01/${options.historicalSlug}`;
    executeSqliteQuerySync(
      db,
      queries
        .updateTable("meeting_transcript_sessions")
        .set({
          selector,
          session_slug: options.historicalSlug,
          export_key: selector.toLowerCase(),
          export_pending_json: '[ "transcript.jsonl" ]',
        })
        .where("session_id", "=", sessionId),
    );
  }
  return session;
}

it("detects and repairs encoded rows without an export root", async () => {
  const sessionId = "x".repeat(85) + ".";
  const historicalSlug = "%78".repeat(85) + "%2E";
  const seeded = await seedStoredSession(sessionId, { historicalSlug });
  await seedStoredSession("ordinary:notes");
  const before = h.snapshot();
  await expectMissing(h.root);
  expect(detectLegacyMeetingTranscripts({ stateDir: h.stateDir }).hasLegacy).toBe(false);
  expect(h.detect()).toMatchObject({ hasLegacy: true });
  expect(h.snapshot()).toEqual(before);

  const result = await migrateClean();
  expect(result.changes).toEqual([expect.stringMatching(/1.*oversized/i)]);
  await closeDatabase();
  const slug = safeTranscriptPathSegment(sessionId);
  const expected = structuredClone(before);
  Object.assign(
    expected.sessions.find((row) => row.session_id === sessionId)!,
    {
      selector: `2026-07-01/${slug}`,
      session_slug: slug,
      export_key: `2026-07-01/${slug}`.toLowerCase(),
    },
  );
  expect(h.snapshot()).toEqual(expected);
  await expectMissing(h.root);
  expect(h.detect().hasLegacy).toBe(false);
  await expect(h.migrate()).resolves.toEqual({ changes: [], warnings: [] });
  expect(h.snapshot()).toEqual(expected);
  const entry = await h.store.readSessionEntry(`2026-07-01/${slug}`);
  expect(entry?.session).toEqual(seeded);
});

it("rolls back all projection repairs when a bounded selector already has another owner", async () => {
  const ids = ["a", "z"].map((prefix) => prefix + "x".repeat(300));
  for (const sessionId of ids) {
    await seedStoredSession(sessionId, { historicalSlug: sessionId });
  }
  await seedStoredSession(safeTranscriptPathSegment(ids[1]!));
  const before = h.snapshot();
  const result = await h.migrate();
  expect(result.changes).toEqual([]);
  expect(result.warnings).toEqual([expect.stringMatching(/UNIQUE constraint failed.*selector/i)]);
  await closeDatabase();
  expect(h.snapshot()).toEqual(before);
  expect(h.detect().hasLegacy).toBe(true);
  await expectMissing(h.root);
});

it("keeps committed repair messages and receipts when pending import recovery cannot finish", async () => {
  await h.seed("legacy");
  await h.migrate({ testHooks: { afterImport: interrupt } });
  await fs.rm(h.root, { recursive: true });
  const sessionId = "notes-" + "x".repeat(300);
  await seedStoredSession(sessionId, { historicalSlug: sessionId });
  const before = h.snapshot();
  const result = await h.migrate();
  expect(result.changes).toEqual([expect.stringMatching(/1.*oversized/i)]);
  expect(result.warnings).toEqual([expect.stringContaining("neither source tree nor archive")]);
  const after = h.snapshot();
  expect([after.runs, after.sources]).toEqual([before.runs, before.sources]);
  expect(after.sessions.find((row) => row.session_id === sessionId)?.session_slug).toBe(
    safeTranscriptPathSegment(sessionId),
  );
  expect(h.detect()).toMatchObject({ hasLegacy: true });
  expect((await h.migrate()).changes).toEqual([]);
  expect(h.snapshot()).toEqual(after);
});

it("requires exclusive state ownership before repairing projections", async () => {
  const sessionId = "notes-" + "x".repeat(300);
  await seedStoredSession(sessionId, { historicalSlug: sessionId });
  const before = h.snapshot();
  await withGatewayLockHeld(h.env, 18_791, async () => {
    const result = await h.migrate();
    expect(result.changes).toEqual([]);
    expect(result.warnings).toEqual([
      expect.stringContaining("exclusive state ownership is unavailable"),
    ]);
    expect(h.snapshot()).toEqual(before);
  });
  expect((await h.migrate()).warnings).toEqual([]);
  expect(h.detect().hasLegacy).toBe(false);
});
