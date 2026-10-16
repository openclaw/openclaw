import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { Compilable } from "kysely";
import { afterEach, describe, expect, it } from "vitest";
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
import {
  recordLegacyMigrationRun,
  recordLegacyMigrationSource,
} from "./state-migrations.receipts.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(async () => {
  await closeOpenClawStateDatabaseAsync();
  closeOpenClawStateDatabaseForTest();
});

async function seedLegacySession(params: {
  stateDir: string;
  sessionId: string;
  date?: string;
  invalidTranscript?: boolean;
  utteranceCount?: number;
  emptyMarkdown?: boolean;
  omitSummaryJson?: boolean;
}): Promise<string> {
  const date = params.date ?? "2026-07-01";
  const sessionDir = path.join(params.stateDir, "transcripts", date, params.sessionId);
  await fs.mkdir(sessionDir, { recursive: true });
  const session = {
    sessionId: params.sessionId,
    title: "Design review",
    source: { providerId: "manual-transcript", meetingUrl: "https://meet.example.invalid/room" },
    startedAt: `${date}T10:00:00.000Z`,
    stoppedAt: `${date}T10:30:00.000Z`,
  };
  await fs.writeFile(
    path.join(sessionDir, "metadata.json"),
    `${JSON.stringify(session, null, 2)}\n`,
  );
  await fs.writeFile(
    path.join(sessionDir, "transcript.jsonl"),
    params.invalidTranscript
      ? "{invalid\n"
      : Array.from({ length: params.utteranceCount ?? 2 }, (_, index) =>
          JSON.stringify({
            id: `u-${index + 1}`,
            sessionId: params.sessionId,
            speaker: { label: index % 2 === 0 ? "Alex" : "Sam" },
            text: index === 0 ? "First line" : index === 1 ? "Second line" : `Line ${index + 1}`,
            final: true,
          }),
        ).join("\n") + "\n",
  );
  const summary = {
    sessionId: params.sessionId,
    title: "Design review",
    generatedAt: `${date}T10:31:00.000Z`,
    overview: "First line. Second line.",
    transcript: ["Alex: First line", "Sam: Second line"],
    decisions: [],
    actionItems: [],
    risks: [],
    utteranceCount: params.utteranceCount ?? 2,
  };
  if (!params.omitSummaryJson) {
    await fs.writeFile(
      path.join(sessionDir, "summary.json"),
      `${JSON.stringify(summary, null, 2)}\n`,
    );
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
  return {
    stateDir,
    env,
    root,
    detect,
    store: new TranscriptsStore(root, { env }),
    database,
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

function nativeSession(sessionId: string) {
  return {
    sessionId,
    source: { providerId: "manual-transcript" },
    startedAt: "2026-07-02T10:00:00.000Z",
  };
}

function interrupt() {
  throw new Error("interrupted");
}

describe("meeting transcript Doctor migration", () => {
  it.runIf(process.platform !== "win32")(
    "rejects a symlinked transcript root before migration",
    async () => {
      const h = harness();
      const externalRoot = tempDirs.make("openclaw-meeting-transcripts-external-");
      await fs.symlink(externalRoot, h.root, "dir");

      expect(() => h.detect()).toThrow("regular directory");
    },
  );

  it.runIf(process.platform !== "win32")(
    "rejects symlinked date and session directories during detection",
    async () => {
      for (const target of ["date", "session"] as const) {
        const h = harness();
        const externalRoot = tempDirs.make("openclaw-meeting-transcripts-external-");
        const transcriptsDir = h.root;
        await fs.mkdir(transcriptsDir, { recursive: true });
        if (target === "date") {
          await fs.symlink(externalRoot, path.join(transcriptsDir, "2026-07-01"), "dir");
        } else {
          const dateDir = path.join(transcriptsDir, "2026-07-01");
          await fs.mkdir(dateDir);
          await fs.symlink(externalRoot, path.join(dateDir, "linked-session"), "dir");
        }

        expect(() => h.detect()).toThrow("cannot be a symlink");
      }
    },
  );

  it("imports shipped dot-only session layouts into reserved SQLite selectors", async () => {
    const h = harness();
    for (const sessionId of [".", "..", "session"]) {
      await h.seed(sessionId);
    }
    const detected = h.detect();
    expect(detected.hasLegacy).toBe(true);

    const result = await h.migrate({ detected });

    expect(result.warnings).toEqual([]);
    const expectedSlugs = new Map([
      [".", "%2E"],
      ["..", "%2E%2E"],
      ["session", "session"],
    ]);
    for (const [sessionId, expectedSlug] of expectedSlugs) {
      const session = await h.store.readSession(sessionId);
      expect(session?.sessionId).toBe(sessionId);
      expect(h.store.sessionDir(session!)).toBe(path.join(h.root, "2026-07-01", expectedSlug));
      const artifacts = await h.store.materializeSessionArtifacts(session!, "transcript");
      const lines = (await fs.readFile(artifacts.transcriptPath, "utf8")).trim().split("\n");
      expect(lines.map((line) => JSON.parse(line).text)).toEqual(["First line", "Second line"]);
    }
  });

  it.runIf(process.platform !== "win32" && process.platform !== "darwin")(
    "imports case-distinct sessions from a case-sensitive legacy tree",
    async () => {
      const h = harness();
      await h.seed("Capital");
      await h.seed("capital");

      const result = await h.migrate();
      expect(result.warnings).toEqual([]);
      await expect(h.store.readSession("2026-07-01/Capital")).resolves.toMatchObject({
        sessionId: "Capital",
      });
      await expect(h.store.readSession("2026-07-01/capital")).resolves.toMatchObject({
        sessionId: "capital",
      });
      const upper = (await h.store.readSession("2026-07-01/Capital"))!;
      const lower = (await h.store.readSession("2026-07-01/capital"))!;
      const upperArtifacts = await h.store.materializeSessionArtifacts(upper, "metadata");
      await h.store.materializeSessionArtifacts(lower, "metadata");
      await fs.rename(upperArtifacts.sessionDir, path.join(h.root, "2026-07-01", "CAPITAL"));
      expect(h.detect()).toMatchObject({ hasLegacy: false });
    },
  );

  it("preflights the whole tree before importing anything", async () => {
    const h = harness();
    const validDir = await h.seed("valid");
    const invalidDir = await h.seed("invalid", { invalidTranscript: true });

    const result = await h.migrate();
    expect(result.changes).toEqual([]);
    expect(result.warnings.join("\n")).toContain("Failed migrating meeting transcripts");
    await expect(fs.stat(validDir)).resolves.toBeDefined();
    await expect(fs.stat(invalidDir)).resolves.toBeDefined();
    const database = h.database();
    expect(
      database.prepare("SELECT COUNT(*) AS count FROM meeting_transcript_sessions").get(),
    ).toEqual({ count: 0 });
  });

  it("detects and recovers a partial-only legacy transcript tree", async () => {
    const h = harness();
    const { stateDir } = h;
    const partialDir = path.join(h.root, "2026-07-01", "partial-only");
    await fs.mkdir(partialDir, { recursive: true });
    await fs.writeFile(path.join(partialDir, "transcript.jsonl"), '{"text":"partial"}\n');
    const detected = h.detect();
    expect(detected.hasLegacy).toBe(true);

    const result = await h.migrate({
      detected,
      now: () => Date.parse("2026-07-02T00:00:00.000Z"),
    });

    expect(result.warnings).toEqual([]);
    expect(result.changes.join("\n")).toContain("incomplete meeting transcript directory");
    await expect(fs.stat(path.join(partialDir, "transcript.jsonl"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(
      fs.stat(
        path.join(
          stateDir,
          "transcripts.partials-recovered-2026-07-02T00-00-00-000Z",
          "2026-07-01",
          "partial-only",
          "transcript.jsonl",
        ),
      ),
    ).resolves.toBeDefined();
  });

  it.runIf(process.platform !== "win32")(
    "preflights every partial artifact before moving any source",
    async () => {
      const h = harness();
      const externalDir = tempDirs.make("openclaw-meeting-transcripts-external-");
      const partialDir = path.join(h.root, "2026-07-01", "partial-invalid");
      await fs.mkdir(partialDir, { recursive: true });
      await fs.writeFile(path.join(partialDir, "summary.md"), "keep me\n");
      await fs.writeFile(path.join(externalDir, "transcript.jsonl"), '{"text":"outside"}\n');
      await fs.symlink(
        path.join(externalDir, "transcript.jsonl"),
        path.join(partialDir, "transcript.jsonl"),
      );
      expect(() => h.detect()).toThrow("regular file");
      await expect(fs.readFile(path.join(partialDir, "summary.md"), "utf8")).resolves.toBe(
        "keep me\n",
      );
    },
  );

  it("rolls back when a session appears between verification and archive", async () => {
    const h = harness();
    const sourceDir = await h.seed("verified");

    const result = await h.migrate({
      testHooks: {
        afterImport: () => {
          const lateDir = path.join(h.root, "2026-07-03", "late-session");
          fsSync.mkdirSync(lateDir, { recursive: true });
          fsSync.writeFileSync(
            path.join(lateDir, "metadata.json"),
            JSON.stringify({
              sessionId: "late-session",
              source: { providerId: "manual-transcript" },
              startedAt: "2026-07-03T10:00:00.000Z",
            }),
          );
        },
      },
    });

    expect(result.changes).toEqual([]);
    expect(result.warnings.join("\n")).toContain("session tree changed before archive");
    await expect(fs.stat(sourceDir)).resolves.toBeDefined();
    await expect(fs.stat(path.join(h.root, "2026-07-03", "late-session"))).resolves.toBeDefined();
    const database = h.database();
    expect(
      database.prepare("SELECT COUNT(*) AS count FROM meeting_transcript_sessions").get(),
    ).toEqual({ count: 0 });
  });

  it("does not mistake a colliding archive destination for a completed move", async () => {
    const h = harness();
    const { stateDir } = h;
    const sourceDir = await h.seed("archive-collision");
    const archiveRoot = path.join(stateDir, "transcripts.migrated-2026-07-02T00-00-00-000Z");

    const result = await h.migrate({
      now: () => Date.parse("2026-07-02T00:00:00.000Z"),
      testHooks: {
        afterImport: () => {
          fsSync.mkdirSync(archiveRoot);
          fsSync.writeFileSync(path.join(archiveRoot, "unrelated"), "keep");
        },
      },
    });

    expect(result.changes).toEqual([]);
    expect(result.warnings.join("\n")).toContain("Failed archiving verified legacy");
    await expect(fs.stat(sourceDir)).resolves.toBeDefined();
    await expect(fs.stat(archiveRoot)).resolves.toBeDefined();
    const database = h.database();
    expect(database.prepare("SELECT COUNT(*) AS count FROM migration_sources").get()).toEqual({
      count: 0,
    });
  });

  it("restores idempotently when a canonical exporter recreated the destination", async () => {
    const h = harness();
    const sourceRoot = h.root;
    const archivedStateDir = tempDirs.make("openclaw-meeting-transcripts-archive-");
    const archivedSessionDir = await seedLegacySession({
      stateDir: archivedStateDir,
      sessionId: "recreated-export",
    });
    const archiveRoot = path.join(archivedStateDir, "transcripts");
    const destination = path.join(sourceRoot, "2026-07-01", "recreated-export");
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.cp(archivedSessionDir, destination, { recursive: true });

    await expect(
      restoreCanonicalMeetingTranscriptExports({
        sourceRoot,
        archiveRoot,
        migratedSourcePaths: [],
        canonicalRelativeDirs: [path.join("2026-07-01", "recreated-export")],
      }),
    ).resolves.toBeUndefined();
    await expect(fs.stat(path.join(destination, "metadata.json"))).resolves.toBeDefined();
    await expect(fs.stat(path.join(archivedSessionDir, "metadata.json"))).resolves.toBeDefined();
  });

  it("rejects canonical restore paths that normalize outside their roots", async () => {
    const h = harness();
    const { stateDir } = h;
    const sourceRoot = h.root;
    const archiveRoot = path.join(stateDir, "transcripts.migrated-test");
    await fs.mkdir(archiveRoot, { recursive: true });

    await expect(
      restoreCanonicalMeetingTranscriptExports({
        sourceRoot,
        archiveRoot,
        migratedSourcePaths: [],
        canonicalRelativeDirs: [path.join("safe", "..", "..", "outside")],
      }),
    ).rejects.toThrow("escaped its root");
  });

  it.runIf(process.platform !== "win32")(
    "rejects symlinked ancestors during canonical export restore",
    async () => {
      const h = harness();
      const { stateDir } = h;
      const archiveRoot = path.join(stateDir, "transcripts.migrated-test");
      const externalRoot = tempDirs.make("openclaw-meeting-transcripts-external-");
      await fs.mkdir(path.join(archiveRoot), { recursive: true });
      await seedLegacySession({ stateDir: externalRoot, sessionId: "linked-export" });
      await fs.symlink(
        path.join(externalRoot, "transcripts", "2026-07-01"),
        path.join(archiveRoot, "2026-07-01"),
        "dir",
      );

      await expect(
        restoreCanonicalMeetingTranscriptExports({
          sourceRoot: h.root,
          archiveRoot,
          migratedSourcePaths: [],
          canonicalRelativeDirs: [path.join("2026-07-01", "linked-export")],
        }),
      ).rejects.toThrow(/symlink/i);
    },
  );

  it("chunks large transcript imports while preserving exact order", async () => {
    const h = harness();
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
    const h = harness();
    await h.seed("empty-summary", { emptyMarkdown: true, omitSummaryJson: true });

    const result = await h.migrate();
    expect(result.warnings).toEqual([]);
    const session = await h.store.readSession("empty-summary");
    await expect(h.store.readSummary(session!)).resolves.toEqual({ markdown: "" });
  });

  it("resumes an interruption after the import commit", async () => {
    const h = harness();
    const native = nativeSession("modified-before-interruption");
    await h.store.writeSession(native);
    const nativeArtifacts = await h.store.materializeSessionArtifacts(native, "metadata");
    await fs.appendFile(nativeArtifacts.metadataPath, " ");
    await h.seed("interrupted-import");

    const interrupted = await h.migrate({ testHooks: { afterImport: interrupt } });
    expect(interrupted.warnings.join("\n")).toContain("interrupted");
    expect(interrupted.changes.join("\n")).toContain("modified meeting transcript export");

    const pending = h.detect();
    expect(pending.pendingImportCount).toBe(1);
    const resumed = await h.migrate({ detected: pending });

    expect(resumed.warnings).toEqual([]);
    expect(resumed.changes.join("\n")).toContain("Resumed and archived");
  });

  it("refuses to archive a new legacy session added after a pending import", async () => {
    const h = harness();
    await h.seed("pending-original");
    await h.migrate({ testHooks: { afterImport: interrupt } });
    const lateDir = await h.seed("pending-late");

    const pending = h.detect();
    const resumed = await h.migrate({ detected: pending });

    expect(resumed.changes).toEqual([]);
    expect(resumed.warnings.join("\n")).toContain("session tree changed before archive");
    await expect(fs.stat(lateDir)).resolves.toBeDefined();
  });

  it("finalizes receipts after interruption following the archive move", async () => {
    const h = harness();
    const native = nativeSession("native-export-during-resume");
    await h.store.writeSession(native);
    await h.store.materializeSessionArtifacts(native, "metadata");
    await h.seed("interrupted-archive");

    const interrupted = await h.migrate({ testHooks: { afterArchive: interrupt } });
    expect(interrupted.warnings.join("\n")).toContain("interrupted");

    const pending = h.detect();
    expect(pending).toMatchObject({ hasLegacy: true, pendingImportCount: 1 });
    const resumed = await h.migrate({ detected: pending });

    expect(resumed.warnings).toEqual([]);
    expect(resumed.changes.join("\n")).toContain("Finalized interrupted");
    await expect(fs.stat(h.store.sessionDir(native))).resolves.toBeDefined();
    const database = h.database();
    expect(
      database
        .prepare("SELECT status, removed_source FROM migration_sources WHERE migration_kind = ?")
        .get("meeting-transcripts-files-v1"),
    ).toEqual({ status: "archived", removed_source: 1 });
  });

  it("does not classify an interrupted export of an advancing transcript as legacy", async () => {
    const h = harness();
    const session = nativeSession("advancing-export");
    await h.store.writeSession(session);
    await h.store.appendUtteranceForSession(session, { text: "first" });
    await h.store.materializeSessionArtifacts(session, "transcript");
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
    expect(
      exported
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line).text),
    ).toEqual(["first", "second"]);
  });

  it("migrates legacy sessions while preserving coexisting SQLite exports", async () => {
    const h = harness();
    const native = { ...nativeSession("native-export"), title: "Native export" };
    const nativeUtterance = { text: "SQLite-native line" };
    const nativeUtterances = [nativeUtterance];
    await h.store.writeSession(native);
    await h.store.appendUtteranceForSession(native, nativeUtterance);
    await h.store.writeSummary(
      summarizeTranscripts({ session: native, utterances: nativeUtterances }),
      native,
    );
    const artifacts = await h.store.materializeSessionArtifacts(native, "all");
    const nativeExport = artifacts.metadataPath;
    const nativeTranscriptExport = artifacts.transcriptPath;
    await fs.rm(nativeExport);
    expect(h.detect()).toMatchObject({ hasLegacy: false });
    await h.seed("legacy-alongside-export");

    const result = await h.migrate();
    expect(result.warnings).toEqual([]);
    await expect(fs.stat(nativeExport)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(nativeTranscriptExport)).resolves.toBeDefined();
    await expect(h.store.readSession("native-export")).resolves.toMatchObject({
      sessionId: "native-export",
    });
    await expect(h.store.readSession("legacy-alongside-export")).resolves.toMatchObject({
      sessionId: "legacy-alongside-export",
    });
  });

  it("resolves a case-renamed export directory by metadata identity", async () => {
    const h = harness();
    const session = nativeSession("Capital");
    await h.store.writeSession(session);
    await h.store.appendUtteranceForSession(session, { text: "case-stable transcript" });
    const artifacts = await h.store.materializeSessionArtifacts(session, "transcript");
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

async function seedStoredSession(
  h: ReturnType<typeof harness>,
  sessionId: string,
  options: { historicalSlug?: string } = {},
) {
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
    // Model the durable projection written before bounded filenames, without
    // constructing an impossible filesystem path or rewriting any note content.
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
    const h = harness();
    const seeded = await seedStoredSession(h, sessionId, { historicalSlug });
    await seedStoredSession(h, "ordinary:notes");
    const before = h.snapshot();
    await expect(fs.stat(h.root)).rejects.toMatchObject({ code: "ENOENT" });
    expect(detectLegacyMeetingTranscripts({ stateDir: h.stateDir }).hasLegacy).toBe(false);
    expect(h.detect()).toMatchObject({ hasLegacy: true, pendingImportCount: 0 });
    expect(h.snapshot()).toEqual(before);

    const result = await h.migrate();
    expect(result.warnings).toEqual([]);
    expect(result.changes).toEqual([expect.stringMatching(/1.*oversized/i)]);
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
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
        expect(
          body
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line)),
        ).toEqual(detail.utterances);
      }
    }
    expect(h.snapshot()).toEqual(expected);
    await expect(fs.stat(h.root)).rejects.toMatchObject({ code: "ENOENT" });
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
    const h = harness();
    const ids = ["a", "z"].map((prefix) => prefix + "x".repeat(300));
    for (const sessionId of ids) {
      await seedStoredSession(h, sessionId, { historicalSlug: sessionId });
    }
    await seedStoredSession(h, safeTranscriptPathSegment(ids[1]!));
    const before = h.snapshot();
    const result = await h.migrate();
    expect(result.changes).toEqual([]);
    expect(result.warnings).toEqual([expect.stringMatching(/UNIQUE constraint failed.*selector/i)]);
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
    expect(h.snapshot()).toEqual(before);
    expect(h.detect().hasLegacy).toBe(true);
    await expect(fs.stat(h.root)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps committed repair messages and receipts when pending import recovery cannot finish", async () => {
    const h = harness();
    const sessionId = "notes-" + "x".repeat(300);
    await seedStoredSession(h, sessionId, { historicalSlug: sessionId });
    recordLegacyMigrationRun(h.database(), {
      runId: "pending-import",
      startedAt: 1,
      finishedAt: null,
      status: "imported",
      reportJson: JSON.stringify({
        format: "meeting-transcripts-files-v1",
        archiveRoot: `${h.root}.migrated-pending`,
        canonicalRelativeDirs: [],
      }),
    });
    recordLegacyMigrationSource(h.database(), {
      sourceKey: "pending-source",
      migrationKind: "meeting-transcripts-files-v1",
      sourcePath: path.join(h.root, "2026-07-01", "legacy"),
      targetTable: "meeting_transcript_sessions",
      sourceSha256: "a".repeat(64),
      sourceSizeBytes: 1,
      sourceRecordCount: 1,
      runId: "pending-import",
      status: "imported",
      importedAt: 1,
      reportJson: "{}",
    });
    const before = h.snapshot();
    const result = await h.migrate();
    expect(result.changes).toEqual([expect.stringMatching(/1.*oversized/i)]);
    expect(result.warnings).toEqual([expect.stringContaining("neither source tree nor archive")]);
    const after = h.snapshot();
    expect(after.runs).toEqual(before.runs);
    expect(after.sources).toEqual(before.sources);
    expect(after.sessions[0]?.session_slug).toBe(safeTranscriptPathSegment(sessionId));
    expect(h.detect()).toMatchObject({ hasLegacy: true, pendingImportCount: 1 });
    expect((await h.migrate()).changes).toEqual([]);
    expect(h.snapshot()).toEqual(after);
  });

  it("requires exclusive state ownership before repairing projections", async () => {
    const h = harness();
    const sessionId = "notes-" + "x".repeat(300);
    await seedStoredSession(h, sessionId, { historicalSlug: sessionId });
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
