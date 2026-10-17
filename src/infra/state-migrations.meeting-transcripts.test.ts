import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { Compilable } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import {
  exportTranscriptLibrary,
  getTranscriptLibrary,
  listTranscriptLibrary,
} from "../transcripts/library.js";
import { safeTranscriptPathSegment } from "../transcripts/store-artifacts.js";
import { TranscriptsStore } from "../transcripts/store.js";
import { summarizeTranscripts } from "../transcripts/summary.js";
import { acquireGatewayLock } from "./gateway-lock.js";
import { executeSqliteQuerySync } from "./kysely-sync.js";
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

afterEach(closeDatabase);

async function seedLegacySession(params: {
  stateDir: string;
  sessionId: string;
  invalidTranscript?: boolean;
  utteranceCount?: number;
  emptyMarkdown?: boolean;
  omitSummaryJson?: boolean;
}): Promise<string> {
  const date = "2026-07-01";
  const sessionDir = await mkdir(params.stateDir, "transcripts", date, params.sessionId);
  const write = (name: string, data: unknown) =>
    fs.writeFile(path.join(sessionDir, name), JSON.stringify(data) + "\n");
  const session = {
    sessionId: params.sessionId,
    title: "Design review",
    source: { providerId: "manual-transcript", meetingUrl: "https://meet.example.invalid/room" },
    startedAt: `${date}T10:00:00.000Z`,
    stoppedAt: `${date}T10:30:00.000Z`,
  };
  await write("metadata.json", session);
  const utterances = Array.from({ length: params.utteranceCount ?? 2 }, (_, index) => ({
    id: `u-${index + 1}`,
    sessionId: params.sessionId,
    speaker: { label: index % 2 === 0 ? "Alex" : "Sam" },
    text: index === 0 ? "First line" : index === 1 ? "Second line" : `Line ${index + 1}`,
    final: true,
  }));
  await fs.writeFile(
    path.join(sessionDir, "transcript.jsonl"),
    params.invalidTranscript
      ? "{invalid\n"
      : utterances.map((line) => JSON.stringify(line)).join("\n") + "\n",
  );
  if (!params.omitSummaryJson) {
    await write("summary.json", {
      ...summarizeTranscripts({ session, utterances }),
      generatedAt: `${date}T10:31:00.000Z`,
    });
  }
  await fs.writeFile(
    path.join(sessionDir, "summary.md"),
    params.emptyMarkdown ? "" : "# Design review\n\nFirst line.\n",
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
    seed: (
      sessionId: string,
      options: Omit<Parameters<typeof seedLegacySession>[0], "stateDir" | "sessionId"> = {},
    ) => seedLegacySession({ stateDir, sessionId, ...options }),
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

function nativeSession(sessionId: string, date = "2026-07-02") {
  return {
    sessionId,
    source: { providerId: "manual-transcript" },
    startedAt: `${date}T10:00:00.000Z`,
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

describe("meeting transcript Doctor migration", () => {
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

  it("imports shipped dot-only session layouts into reserved SQLite selectors", async () => {
    for (const sessionId of [".", "..", "session"]) {
      await h.seed(sessionId);
    }
    const detected = h.detect();
    expect(detected.hasLegacy).toBe(true);

    const result = await h.migrate({ detected });

    expect(result.warnings).toEqual([]);
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
    }
  });

  it.runIf(process.platform !== "win32" && process.platform !== "darwin")(
    "imports case-distinct sessions from a case-sensitive legacy tree",
    async () => {
      await h.seed("Capital");
      await h.seed("capital");

      const result = await h.migrate();
      expect(result.warnings).toEqual([]);
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
    ["invalid transcript", "Failed migrating meeting transcripts", "meeting_transcript_sessions"],
    ["new session", "session tree changed before archive", "meeting_transcript_sessions"],
    ["archive collision", "Failed archiving verified legacy", "migration_sources"],
  ] as const)("rolls back without moving sources after %s", async (failure, warning, table) => {
    const source = await h.seed("verified");
    const collision = failure === "archive collision";
    const other =
      failure === "invalid transcript"
        ? await h.seed("invalid", { invalidTranscript: true })
        : collision
          ? path.join(h.stateDir, "transcripts.migrated-2026-07-02T00-00-00-000Z")
          : path.join(h.root, "2026-07-03", "late-session");
    const result = await h.migrate({
      now: () => Date.parse("2026-07-02T00:00:00.000Z"),
      testHooks:
        failure === "invalid transcript"
          ? {}
          : {
              afterImport: () => {
                fsSync.mkdirSync(other, { recursive: true });
                fsSync.writeFileSync(
                  path.join(other, collision ? "unrelated" : "metadata.json"),
                  collision ? "keep" : JSON.stringify(nativeSession("late-session", "2026-07-03")),
                );
              },
            },
    });
    expect(result.changes).toEqual([]);
    expect(result.warnings.join("\n")).toContain(warning);
    await expectExists(source, other);
    h.expectEmpty(table);
  });

  it("detects and recovers a partial-only legacy transcript tree", async () => {
    const partialDir = await mkdir(h.root, "2026-07-01", "partial-only");
    await fs.writeFile(path.join(partialDir, "transcript.jsonl"), '{"text":"partial"}\n');
    const detected = h.detect();
    expect(detected.hasLegacy).toBe(true);

    const result = await h.migrate({
      detected,
      now: () => Date.parse("2026-07-02T00:00:00.000Z"),
    });

    expect(result.warnings).toEqual([]);
    expect(result.changes.join("\n")).toContain("incomplete meeting transcript directory");
    await expectMissing(path.join(partialDir, "transcript.jsonl"));
    await expectExists(
      path.join(
        h.stateDir,
        "transcripts.partials-recovered-2026-07-02T00-00-00-000Z",
        "2026-07-01",
        "partial-only",
        "transcript.jsonl",
      ),
    );
  });

  it("restores idempotently when a canonical exporter recreated the destination", async () => {
    const archivedStateDir = tempDirs.make("openclaw-meeting-transcripts-archive-");
    const archivedSessionDir = await seedLegacySession({
      stateDir: archivedStateDir,
      sessionId: "recreated-export",
    });
    const archiveRoot = path.join(archivedStateDir, "transcripts");
    const destination = path.join(h.root, "2026-07-01", "recreated-export");
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
    await seedLegacySession({ stateDir: externalRoot, sessionId: "linked-export" });
    await fs.symlink(
      path.join(externalRoot, "transcripts", "2026-07-01"),
      path.join(archiveRoot, "2026-07-01"),
      "dir",
    );

    await expect(h.restore(archiveRoot, path.join("2026-07-01", "linked-export"))).rejects.toThrow(
      /symlink/i,
    );
  });

  it("chunks large transcript imports while preserving exact order", async () => {
    await h.seed("long-meeting", { utteranceCount: 530 });

    const result = await h.migrate();
    expect(result.warnings).toEqual([]);
    const session = await h.store.readSession("long-meeting");
    const utterances = await h.store.readUtterancesForSession(session!);
    expect(utterances).toHaveLength(530);
    expect(utterances[0]).toMatchObject({ id: "u-1", text: "First line" });
    expect(utterances.at(-1)).toMatchObject({ id: "u-530", text: "Line 530" });
  });

  it("preserves an existing empty markdown summary", async () => {
    await h.seed("empty-summary", { emptyMarkdown: true, omitSummaryJson: true });

    const result = await h.migrate();
    expect(result.warnings).toEqual([]);
    const session = await h.store.readSession("empty-summary");
    await expect(h.store.readSummary(session!)).resolves.toEqual({ markdown: "" });
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
      expect(pending.pendingImportCount).toBe(1);
      if (stage === "archive") {
        expect(pending.hasLegacy).toBe(true);
      }
      const resumed = await h.migrate({ detected: pending });
      expect(resumed.warnings).toEqual([]);
      expect(resumed.changes.join("\n")).toContain(
        stage === "import" ? "Resumed and archived" : "Finalized interrupted",
      );
      if (stage === "archive") {
        await expectExists(h.store.sessionDir(native));
        expect(
          h
            .database()
            .prepare(
              "SELECT status, removed_source FROM migration_sources WHERE migration_kind = ?",
            )
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

    const database = h.database();
    database
      .prepare(
        "UPDATE meeting_transcript_sessions SET export_pending_json = ? WHERE session_id = ?",
      )
      .run('["transcript.jsonl"]', session.sessionId);
    await fs.writeFile(path.join(h.store.sessionDir(session), "transcript.jsonl"), '{"text":');

    const detected = h.detect();
    expect(detected).toMatchObject({ hasLegacy: false });
    await expect(h.migrate({ detected })).resolves.toEqual({ changes: [], warnings: [] });

    await h.store.materializeSessionArtifacts(session, "transcript");
    const exported = await fs.readFile(
      path.join(h.store.sessionDir(session), "transcript.jsonl"),
      "utf8",
    );
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

    const result = await h.migrate();
    expect(result.warnings).toEqual([]);
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
    const renamedDir = path.join(h.root, "2026-07-02", "capital");
    await fs.rename(artifacts.sessionDir, renamedDir);
    await fs.rename(path.join(renamedDir, "metadata.json"), path.join(renamedDir, "METADATA.JSON"));

    expect(h.detect()).toMatchObject({ hasLegacy: false });
    await fs.rm(path.join(renamedDir, "METADATA.JSON"));
    const metadataLessDetected = h.detect();
    expect(metadataLessDetected.hasLegacy).toBe(!fsSync.existsSync(artifacts.sessionDir));
    await fs.writeFile(
      path.join(renamedDir, "METADATA.JSON"),
      `${JSON.stringify(session, null, 2)}\n `,
    );
    const detected = h.detect();
    expect(detected.hasLegacy).toBe(true);

    const recovered = await h.migrate({ detected });
    expect(recovered.warnings).toEqual([]);
    expect(recovered.changes.join("\n")).toContain("modified meeting transcript export");
    await expect(h.store.readSession("2026-07-02/Capital")).resolves.toMatchObject({
      sessionId: "Capital",
    });
  });
});

async function seedStoredSession(sessionId: string, options: { historicalSlug?: string } = {}) {
  const session = {
    sessionId,
    startedAt: "2026-07-01T10:00:00.000Z",
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
  return { session, summary, markdown };
}

describe("meeting transcript Doctor oversized projections", () => {
  it("detects and repairs encoded rows without an export root", async () => {
    const sessionId = "x".repeat(85) + ".";
    const historicalSlug = "%78".repeat(85) + "%2E";
    const seeded = await seedStoredSession(sessionId, { historicalSlug });
    await seedStoredSession("ordinary:notes");
    const before = h.snapshot();
    await expectMissing(h.root);
    expect(detectLegacyMeetingTranscripts({ stateDir: h.stateDir }).hasLegacy).toBe(false);
    expect(h.detect()).toMatchObject({ hasLegacy: true, pendingImportCount: 0 });
    expect(h.snapshot()).toEqual(before);

    const result = await h.migrate();
    expect(result.warnings).toEqual([]);
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
    const listed = (await listTranscriptLibrary(h.store, {})).sessions.find(
      (entry) => entry.sessionId === sessionId,
    );
    expect(listed?.selector).toBe(`2026-07-01/${slug}`);
    const selector = listed!.selector;
    const detail = await getTranscriptLibrary(h.store, { selector, includeUtterances: true });
    expect(detail.session).toMatchObject({
      sessionId,
      selector,
      utteranceCount: 1,
      hasSummary: true,
    });
    expect(detail.utterances).toEqual([{ sequence: 0, text: "Preserve this note.", final: true }]);
    for (const format of ["markdown", "jsonl"] as const) {
      const exported = await exportTranscriptLibrary(h.store, { selector, format });
      const body = Buffer.from(exported.data, "base64").toString("utf8");
      expect(exported.selector).toBe(selector);
      expect(Buffer.byteLength(exported.filename)).toBeLessThanOrEqual(255);
      expect(body).toContain("Preserve this note.");
      if (format === "jsonl") {
        expect(jsonLines(body)).toEqual(detail.utterances);
      }
    }
    expect(h.snapshot()).toEqual(expected);
    await expectMissing(h.root);
    expect(h.detect().hasLegacy).toBe(false);
    await expect(h.migrate()).resolves.toEqual({ changes: [], warnings: [] });
    expect(h.snapshot()).toEqual(expected);
    const entry = await h.store.readSessionEntry(`2026-07-01/${slug}`);
    expect(entry?.session).toEqual(seeded.session);
    expect(await h.store.readSummary(seeded.session)).toEqual({
      summary: seeded.summary,
      markdown: seeded.markdown,
    });
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
    expect(h.detect()).toMatchObject({ hasLegacy: true, pendingImportCount: 1 });
    expect((await h.migrate()).changes).toEqual([]);
    expect(h.snapshot()).toEqual(after);
  });

  it("requires exclusive state ownership before repairing projections", async () => {
    const sessionId = "notes-" + "x".repeat(300);
    await seedStoredSession(sessionId, { historicalSlug: sessionId });
    const before = h.snapshot();
    const lock = await acquireGatewayLock({ allowInTests: true, env: h.env });
    if (!lock) {
      throw new Error("expected test Gateway lock");
    }
    try {
      const result = await h.migrate();
      expect(result.changes).toEqual([]);
      expect(result.warnings).toEqual([
        expect.stringContaining("exclusive state ownership is unavailable"),
      ]);
      expect(h.snapshot()).toEqual(before);
    } finally {
      await lock.release();
    }
    expect((await h.migrate()).warnings).toEqual([]);
    expect(h.detect().hasLegacy).toBe(false);
  });
});
