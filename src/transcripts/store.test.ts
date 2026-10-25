import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { executeSqliteQuerySync } from "../infra/kysely-sync.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseByPathAsync,
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import { observeMainThreadSql } from "../test-utils/main-thread-sql-spies.test-support.js";
import type { TranscriptSessionDescriptor, TranscriptUtterance } from "./provider-types.js";
import { appendMeetingTranscriptUtterance, meetingTranscriptDb } from "./store-sqlite.js";
import { transcriptSessionSelector, TranscriptsStore } from "./store.js";
import { summarizeTranscripts } from "./summary.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterAll(async () => {
    await closeDatabase();
    cleanup();
  }),
);
let suiteStateDir: string;
let store: TranscriptsStore;

function databaseOptions(stateDir = suiteStateDir) {
  return { env: { ...process.env, OPENCLAW_STATE_DIR: stateDir } };
}

async function closeDatabase() {
  await closeOpenClawStateDatabaseAsync();
  closeOpenClawStateDatabaseForTest();
}

function stateDatabase() {
  return openOpenClawStateDatabase(databaseOptions()).db;
}

function writeTransaction(write: (database: ReturnType<typeof stateDatabase>) => void) {
  runOpenClawStateWriteTransaction(({ db }) => write(db), databaseOptions(), {
    operationLabel: "test.transcripts.write",
  });
}

async function appendEach(
  target: TranscriptSessionDescriptor,
  rows: TranscriptUtterance[],
  copies = 1,
) {
  for (const row of rows) {
    for (let copy = 0; copy < copies; copy++) {
      await store.appendUtteranceForSession(target, row);
    }
  }
}

async function admit(target = session(), rows: (string | TranscriptUtterance)[] = []) {
  await store.writeSession(target);
  await appendEach(
    target,
    rows.map((row) => (typeof row === "string" ? { text: row } : row)),
  );
  return target;
}

async function expectTexts(target: TranscriptSessionDescriptor, texts: string[], reader = store) {
  expect(await reader.readUtterancesForSession(target)).toMatchObject(
    texts.map((text) => ({ text })),
  );
}

async function expectSnapshot(target: TranscriptSessionDescriptor, texts: string[]) {
  const snapshot = await store.readSummarySnapshot(target, 20);
  expect(snapshot).toMatchObject({
    nextSequence: texts.length,
    utterances: texts.map((text) => ({ text })),
  });
  return snapshot;
}

function updateExports(
  target: TranscriptSessionDescriptor,
  values: { export_pending_json?: string; export_manifest_json?: string },
) {
  writeTransaction((db) => {
    executeSqliteQuerySync(
      db,
      meetingTranscriptDb(db)
        .updateTable("meeting_transcript_sessions")
        .set(values)
        .where("session_id", "=", target.sessionId)
        .where("started_at", "=", target.startedAt),
    );
  });
}

async function expectLegacyRejection(target: TranscriptSessionDescriptor) {
  await expect(store.writeSession(target)).rejects.toThrow("run openclaw doctor --fix");
  await expect(store.readSession(target.sessionId)).resolves.toBeUndefined();
}

function writeNotes(target: TranscriptSessionDescriptor, text: string) {
  return store.writeSummary(
    summarizeTranscripts({ session: target, utterances: [{ text }] }),
    target,
  );
}

function caseDistinctSessions() {
  return [session("Capital"), session("capital", "2026-07-01T11:00:00.000Z")] as const;
}

function writeLegacyArtifact(directory: string, text = "legacy\n", name = "transcript.jsonl") {
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, name);
  fs.writeFileSync(file, text);
  return file;
}

const readText = (file: string) => fs.readFileSync(file, "utf8");

beforeAll(() => {
  suiteStateDir = tempDirs.make("openclaw-transcript-test-");
});

beforeEach(() => {
  // Retain the worker while isolating each case's rows and exported artifacts.
  writeTransaction((db) => {
    executeSqliteQuerySync(db, meetingTranscriptDb(db).deleteFrom("meeting_transcript_sessions"));
  });
  fs.rmSync(path.join(suiteStateDir, "transcripts"), { recursive: true, force: true });
  store = createStore();
});

function createStore(stateDir = suiteStateDir) {
  return new TranscriptsStore(path.join(stateDir, "transcripts"), databaseOptions(stateDir));
}

async function probeExclusiveDatabaseAccess(databasePath: string): Promise<void> {
  await closeOpenClawStateDatabaseByPathAsync(databasePath);
  const database = new DatabaseSync(databasePath);
  try {
    database.exec("PRAGMA busy_timeout=0; PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE;");
  } finally {
    try {
      if (database.isTransaction) {
        database.exec("ROLLBACK");
      }
    } finally {
      database.close();
    }
  }
}

function session(
  sessionId = "session-1",
  startedAt = "2026-07-01T10:00:00.000Z",
): TranscriptSessionDescriptor {
  return { sessionId, source: { providerId: "manual-transcript" }, startedAt };
}

it("lists summary presence by complete session identity", async () => {
  const first = await admit(session("repeated"));
  const later = await admit(session("repeated", "2026-07-02T10:00:00.000Z"));
  const sibling = await admit(session("sibling", later.startedAt));
  const expected = (hasSummary: boolean) => [
    { session: later, hasSummary: false },
    { session: sibling, hasSummary: false },
    { session: first, hasSummary },
  ];
  expect(await store.listSessionEntries()).toMatchObject(expected(false));
  await store.writeSummary(summarizeTranscripts({ session: first, utterances: [] }), first);
  expect(await store.listSessionEntries()).toMatchObject(expected(true));
});

it("isolates returned list pages and observes another store's writes", async () => {
  const writer = createStore();
  const target = { ...session(), title: "Initial title" };
  await writer.writeSession(target);
  const options = { limit: 50, projection: "public" } as const;
  const page = async (reader = store) => (await reader.listReadEntries(options)).entries;
  const initial = await page();
  expect(initial).toMatchObject([{ title: "Initial title", utteranceCount: 0 }]);
  initial[0]!.title = "Caller mutation";

  expect(await page(createStore())).toMatchObject([{ title: "Initial title", utteranceCount: 0 }]);
  await writer.writeSession({ ...target, title: "Updated title" });
  expect(await page()).toMatchObject([{ title: "Updated title", utteranceCount: 0 }]);
  await writer.appendUtteranceForSession(target, { text: "New speech", final: true });
  expect(await page()).toMatchObject([{ title: "Updated title", utteranceCount: 1 }]);
  expect((await store.listReadEntries({ ...options, query: "absent" })).entries).toEqual([]);
  expect(await page()).toHaveLength(1);
});

it.each(["empty", "speech", "summary", "export", "pending export", "rewritten"] as const)(
  "discards only unchanged empty failed admissions (%s)",
  async (state) => {
    const target = { ...session("abandoned"), stoppedAt: "2026-07-01T10:00:01.000Z" };
    const { inputRevision: expectedInputRevision } = await store.writeSession(target);
    if (state === "speech") {
      await store.appendUtteranceForSession(target, { text: "Retained speech", final: true });
    } else if (state === "summary") {
      await store.writeSummary(summarizeTranscripts({ session: target, utterances: [] }), target);
    } else if (state === "export") {
      await store.materializeSessionArtifacts(target, "all");
    } else if (state === "pending export") {
      // Model an interrupted export before it has recorded its final artifact hashes.
      updateExports(target, { export_pending_json: '["metadata.json"]' });
    } else if (state === "rewritten") {
      await store.writeSession({ ...target, title: "Updated by another owner" });
    }
    const saved = await store.readSession(target.sessionId);
    await store.deleteEmptySessionCandidate(target, {
      expectedInputRevision,
      assertCurrent: () => undefined,
    });
    expect(await store.readSession(target.sessionId)).toEqual(
      state === "empty" ? undefined : saved,
    );
    if (state === "speech") {
      await expectTexts(target, ["Retained speech"]);
    } else if (state === "summary") {
      expect((await store.readSummary(target)).summary).toBeDefined();
    } else if (state === "export") {
      expect(fs.existsSync(path.join(store.sessionDir(target), "metadata.json"))).toBe(true);
    }
  },
);

it("keeps source matching and overview projections current after replacement", async () => {
  const source = {
    providerId: "manual-transcript",
    accountId: "account",
    guildId: "guild",
    channelId: "channel",
    meetingUrl: "https://example.test/meeting",
    threadTs: "thread",
    fileId: "file",
  };
  const target = await admit({
    ...session(),
    source,
    metadata: { agentId: "agent" },
    stoppedAt: "2026-07-01T11:00:00.000Z",
  });
  const recent = (locator: typeof target.source) =>
    store.readRecentStoppedSession(locator, target.startedAt, "2026-07-01T11:00:00.000Z");
  expect((await recent(source))?.session).toEqual(target);
  expect((await store.listReadEntries({ agentId: "agent" })).entries).toHaveLength(1);
  const replacement = {
    ...target,
    source: { providerId: source.providerId, accountId: "replacement" },
    metadata: {},
  };
  await store.writeSession(replacement);
  expect(await recent(source)).toBeUndefined();
  expect((await recent(replacement.source))?.session).toEqual(replacement);
  expect((await store.listReadEntries({ agentId: "agent" })).entries).toEqual([]);
  const summary = summarizeTranscripts({ session: target, utterances: [] });
  await store.writeSummary({ ...summary, overview: "Initial overview" }, target);
  await store.writeSummary({ ...summary, overview: "Replacement overview" }, target);
  expect((await store.listReadEntries({})).entries).toMatchObject([
    { overview: "Replacement overview" },
  ]);
});

it("keeps summary snapshot queries bound to the current session and persisted revision", async () => {
  const first = await admit(session("summary-first"), ["First speech"]);
  const second = await admit({ ...session("summary-second"), title: "Second meeting" }, [
    "Second speech",
  ]);
  const later = await admit(session("summary-first", "2026-07-02T10:00:00.000Z"), [
    "Next day speech",
  ]);
  const firstSnapshot = await expectSnapshot(first, ["First speech"]);
  await expectSnapshot(second, ["Second speech"]);
  await expectSnapshot(later, ["Next day speech"]);
  await store.appendUtteranceForSession(first, { text: "Later speech" });
  const updated = await expectSnapshot(first, ["First speech", "Later speech"]);
  expect(updated?.inputRevision).not.toBe(firstSnapshot?.inputRevision);
  expect(await store.readSummarySnapshot(session("missing"), 20)).toBeUndefined();
});

it.each(["cancel", "consumer-error"] as const)("releases snapshots after %s", async (finish) => {
  const target = await admit(session(), ["first", "second"]);
  const controller = new AbortController();
  const failure = new Error("consumer stopped reading");
  const reading = store.streamExport(
    transcriptSessionSelector(target),
    false,
    (rows) => {
      expect(rows.map((row) => row.text)).toEqual(["first", "second"]);
      if (finish === "cancel") {
        controller.abort(failure);
      } else {
        throw failure;
      }
    },
    controller.signal,
  );
  await expect(reading).rejects.toThrow("consumer stopped reading");
  await expect(
    probeExclusiveDatabaseAccess(path.join(suiteStateDir, "state", "openclaw.sqlite")),
  ).resolves.toBeUndefined();
  await expectTexts(target, ["first", "second"]);
});

it.each(["rewrite", "reset"] as const)(
  "isolates export snapshots from %s and appends",
  async (change) => {
    const target = await admit({ ...session(), title: "Original meeting" });
    const database = openOpenClawStateDatabase(databaseOptions());
    writeTransaction((db) => {
      for (let index = 0; index < 130; index++) {
        appendMeetingTranscriptUtterance({
          database: db,
          session: target,
          utterance: { text: `row-${index}` },
          metadataJson: null,
          now: index,
        });
      }
    });
    await writeNotes(target, "Original note");
    const texts: string[] = [];
    let batches = 0;
    const result = await store.streamExport(
      transcriptSessionSelector(target),
      true,
      async (rows) => {
        texts.push(...rows.map((row) => row.text));
        if (batches++ === 0) {
          const foreign = new DatabaseSync(database.path);
          try {
            if (change === "reset") {
              foreign.exec("PRAGMA foreign_keys = ON");
              foreign
                .prepare("DELETE FROM meeting_transcript_sessions WHERE session_id = ?")
                .run(target.sessionId);
            } else {
              foreign
                .prepare("UPDATE meeting_transcript_utterances SET text = ? WHERE session_id = ?")
                .run("Foreign replacement", target.sessionId);
            }
          } finally {
            foreign.close();
          }
          await store.writeSession({ ...target, title: "New meeting" });
          await store.appendUtteranceForSession(target, { text: "Later append" });
          await writeNotes(target, "New note");
        }
      },
    );
    expect(batches).toBeGreaterThan(1);
    expect(texts).toEqual(Array.from({ length: 130 }, (_, index) => `row-${index}`));
    expect(result.entry.session.title).toBe("Original meeting");
    expect(result.notes?.markdown).toContain("Original note");
    const refreshed: string[] = [];
    const next = await store.streamExport(transcriptSessionSelector(target), true, (rows) => {
      refreshed.push(...rows.map((row) => row.text));
    });
    expect(refreshed).toEqual([
      ...(change === "reset" ? [] : Array<string>(130).fill("Foreign replacement")),
      "Later append",
    ]);
    expect(next.entry.session.title).toBe("New meeting");
    expect(next.notes?.markdown).toContain("New note");
  },
);

it("retains admitted ID origins across updates, reopen, and Doctor restoration", async () => {
  const cases = [undefined, null, "invalid", "generated", "supplied"].map((origin) => ({
    origin,
    target: {
      ...session(`origin-${String(origin)}`),
      metadata: {
        agentId: "original",
        ...(origin === undefined ? {} : { sessionIdOrigin: origin }),
      },
    },
  }));
  for (const { target } of cases) {
    await admit(target, ["Saved history"]);
  }
  await closeDatabase();
  const canonical = new Map<string, TranscriptSessionDescriptor | undefined>();
  const restoredState = tempDirs.make("transcript-origin-restore-");
  fs.mkdirSync(path.join(restoredState, "transcripts", "2026-07-01"), { recursive: true });
  for (const { origin, target } of cases) {
    for (const metadata of [undefined, { sessionIdOrigin: "generated", agentId: "updated" }]) {
      await store.writeSession({ ...target, metadata, stoppedAt: "2026-07-01T10:01:00.000Z" });
      const stored = await store.readSession(target.sessionId);
      expect(stored?.metadata ?? {}, target.sessionId).toEqual({
        ...(metadata ? { agentId: metadata.agentId } : {}),
        ...(origin === undefined ? {} : { sessionIdOrigin: origin }),
      });
      await expectTexts(target, ["Saved history"]);
    }
    canonical.set(target.sessionId, await store.readSession(target.sessionId));
    const exported = await store.materializeSessionArtifacts(target, "all");
    fs.cpSync(
      exported.sessionDir,
      path.join(restoredState, "transcripts", "2026-07-01", target.sessionId),
      { recursive: true },
    );
  }
  await closeDatabase();
  const { detectLegacyMeetingTranscripts, migrateLegacyMeetingTranscripts } =
    await import("../infra/state-migrations.meeting-transcripts.js");
  const env = { ...process.env, OPENCLAW_STATE_DIR: restoredState };
  const migrated = await migrateLegacyMeetingTranscripts({
    detected: detectLegacyMeetingTranscripts({
      stateDir: restoredState,
      doctorOnlyStateMigrations: true,
    }),
    stateDir: restoredState,
    env,
  });
  expect(migrated.warnings).toEqual([]);
  const restored = createStore(restoredState);
  for (const { target } of cases) {
    expect(await restored.readSession(target.sessionId), target.sessionId).toEqual(
      canonical.get(target.sessionId),
    );
    await expectTexts(target, ["Saved history"], restored);
  }
});

it("bounds exact retry lookups to one caption ID without adding statements", async () => {
  const target = await admit();
  writeTransaction((db) => {
    const queries: string[] = [];
    const sql = observeMainThreadSql({ onStatement: (query) => queries.push(query) });
    try {
      const append = (utterance: TranscriptUtterance) => {
        sql.clear();
        queries.length = 0;
        appendMeetingTranscriptUtterance({
          database: db,
          session: target,
          utterance,
          metadataJson: null,
          now: 1,
        });
        return [...queries];
      };
      const utterance = { id: "new-caption", text: "Speech" };
      const statements = append(utterance);
      expect(statements).toHaveLength(4);
      const retryQuery = statements.find((query) =>
        /^select .* from "meeting_transcript_utterances"/u.test(query),
      );
      expect(retryQuery).toBeDefined();
      const plan = db.prepare(`EXPLAIN QUERY PLAN ${retryQuery}`).all();
      expect(plan).toContainEqual(
        expect.objectContaining({
          detail: expect.stringContaining(
            "idx_meeting_transcript_utterances_id (session_id=? AND session_started_at=? AND utterance_id=?)",
          ),
        }),
      );
      expect(append(utterance)).toHaveLength(1);
      expect(append({ text: "No ID" })).toHaveLength(3);
    } finally {
      sql.restore();
    }
  });
});

it("deduplicates exact retries but preserves same-id revisions", async () => {
  const target = await admit();
  const interim = { id: "utterance-1", text: "draft" };
  const revisions: TranscriptUtterance[] = [
    interim,
    { ...interim, final: false },
    { ...interim, final: true },
    { ...interim, text: "draft\0revision" },
    { ...interim, startedAt: "" },
    { ...interim, startedAt: "2026-07-01T10:00:01.000Z" },
    { ...interim, endedAt: "2026-07-01T10:00:02.000Z" },
    { ...interim, speaker: { label: "" } },
    { ...interim, speaker: { label: "Sam" } },
    { ...interim, speaker: { id: "speaker-1", label: "Sam" } },
    { ...interim, metadata: {} },
    { ...interim, metadata: { language: "en", confidence: 1 } },
    { ...interim, metadata: { confidence: 1, language: "en" } },
  ];
  await appendEach(target, revisions, 2);
  await appendEach(target, revisions);
  await expect(store.readUtterancesForSession(target)).resolves.toEqual(
    revisions.map((revision) => Object.assign({ sessionId: target.sessionId }, revision)),
  );

  for (const other of [session("other"), session(target.sessionId, "2026-07-02T10:00:00.000Z")]) {
    await admit(other, [interim]);
    await expect(store.readUtterancesForSession(other)).resolves.toEqual([
      { ...interim, sessionId: other.sessionId },
    ]);
  }
});

it("does not treat SQLite's replacement of lone surrogates as an exact retry", async () => {
  const target = await admit();
  const revisions: TranscriptUtterance[] = [
    { id: "text", text: "\ud800" },
    { id: "start", text: "draft", startedAt: "\ud800" },
    { id: "end", text: "draft", endedAt: "\ud800" },
    { id: "speaker-id", text: "draft", speaker: { id: "\ud800", label: "Sam" } },
    { id: "speaker-label", text: "draft", speaker: { label: "\ud800" } },
  ];
  await appendEach(target, revisions, 2);
  const stored = await store.readUtterancesForSession(target);
  expect(stored.map((row) => row.id)).toEqual(revisions.flatMap((row) => [row.id, row.id]));
  await appendEach(target, stored);
  await expect(store.readUtterancesForSession(target)).resolves.toEqual(stored);
});

it("requires dated selectors for repeated sessions", async () => {
  const id = "standup";
  await store.writeSession(session(id, "2026-07-01T10:00:00.000Z"));
  await store.writeSession(session(id, "2026-07-02T10:00:00.000Z"));

  await expect(store.readSession(id)).rejects.toThrow("multiple transcripts sessions match");
  await expect(store.readSession(`2026-07-01/${id}`)).resolves.toMatchObject({
    startedAt: "2026-07-01T10:00:00.000Z",
  });
});

it.each([false, true])("prefers qualified targets (reverse insertion: %s)", async (reverse) => {
  const raw = session("2026-07-03/raw-id", "2026-07-04T10:00:00.000Z");
  const qualified = session("raw-id", "2026-07-03T10:00:00.000Z");
  for (const target of reverse ? [qualified, raw] : [raw, qualified]) {
    await store.writeSession(target);
  }
  await closeDatabase();
  await expect(store.readSession(raw.sessionId)).resolves.toEqual(qualified);
  await expect(store.readSession("2026-07-04/2026-07-03-raw-id")).resolves.toEqual(raw);
  await expect(store.readSession(`2026-07-04/${raw.sessionId}`)).resolves.toEqual(raw);
});

it.each(["exported", "concurrent"] as const)(
  "rejects selector conflicts with %s owners",
  async (mode) => {
    const original = session("standup", "2026-07-01T10:00:00.000Z");
    const firstWrite = store.writeSession(original);
    if (mode === "exported") {
      await firstWrite;
      await store.materializeSessionArtifacts(original, "metadata");
    }
    const competing = session("standup", "2026-07-01T11:00:00.000Z");
    const outcomes = await Promise.allSettled([firstWrite, store.writeSession(competing)]);
    expect(outcomes.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((result) => result.status === "rejected")).toEqual([
      {
        status: "rejected",
        reason: expect.objectContaining({ name: "TranscriptSessionConflictError" }),
      },
    ]);
    await expect(store.readSession(original.sessionId)).resolves.toEqual(
      outcomes[0].status === "fulfilled" ? original : competing,
    );
  },
);

it("stores case-distinct sessions and rejects only unsafe export collisions", async () => {
  const [upper, lower] = caseDistinctSessions();
  await store.writeSession(lower);
  await store.materializeSessionArtifacts(lower, "metadata");
  await expect(store.writeSession(upper)).resolves.toMatchObject({
    inserted: true,
    inputRevision: expect.any(String),
  });

  if (fs.existsSync(store.sessionDir(upper))) {
    await expect(store.materializeSessionArtifacts(lower, "metadata")).resolves.toMatchObject({
      metadataPath: path.join(store.sessionDir(lower), "metadata.json"),
    });
    await expect(store.materializeSessionArtifacts(upper, "metadata")).rejects.toThrow(
      "collides case-insensitively",
    );
  } else {
    await expect(store.materializeSessionArtifacts(upper, "metadata")).resolves.toMatchObject({
      metadataPath: path.join(store.sessionDir(upper), "metadata.json"),
    });
  }
});

it("recognizes case-variant artifact names only when the filesystem aliases them", async () => {
  const [upper, lower] = caseDistinctSessions();
  await store.writeSession(upper);
  expect(fs.existsSync(store.sessionDir(upper))).toBe(false);
  writeLegacyArtifact(store.sessionDir(lower), "legacy\n", "TRANSCRIPT.JSONL");
  expect(fs.readdirSync(store.sessionDir(lower))).toContain("TRANSCRIPT.JSONL");

  if (fs.existsSync(path.join(store.sessionDir(lower), "transcript.jsonl"))) {
    await expect(store.writeSession(lower)).rejects.toThrow("run openclaw doctor --fix");
  } else {
    await expect(store.writeSession(lower)).resolves.toMatchObject({
      inserted: true,
      inputRevision: expect.any(String),
    });
  }
});

it.each(["unclaimed", "case-distinct owner", "dot-root"] as const)(
  "does not overwrite a legacy directory with %s ownership",
  async (kind) => {
    const [upper, lower] = caseDistinctSessions();
    const target =
      kind === "case-distinct owner"
        ? lower
        : session(kind === "dot-root" ? ".." : "legacy-collision");
    if (kind === "case-distinct owner") {
      await store.writeSession(upper);
      updateExports(upper, { export_pending_json: '["metadata.json","transcript.jsonl"]' });
    } else if (kind === "dot-root") {
      await store.writeSession(session("."));
    }
    const directory =
      kind === "dot-root" ? path.join(suiteStateDir, "transcripts") : store.sessionDir(target);
    const artifact = writeLegacyArtifact(directory, '{"text":"legacy line"}\n');
    await expectLegacyRejection(target);
    expect(readText(artifact)).toContain("legacy line");
  },
);

it.runIf(process.platform !== "win32")(
  "checks the shipped slug path before inserting a portable encoded session",
  async () => {
    const target = session("trailing-dot.");
    const legacyDir = path.join(suiteStateDir, "transcripts", "2026-07-01", "trailing-dot.");
    writeLegacyArtifact(legacyDir);

    await expectLegacyRejection(target);
  },
);

it("exports canonical durable notes, recovers concurrent manifests, and preserves externally edited artifacts", async () => {
  const exportRoot = path.join(suiteStateDir, "transcripts");
  fs.mkdirSync(exportRoot, { recursive: true });
  fs.chmodSync(exportRoot, 0o770);
  const target = {
    ...session("ansi-\u001b[31mprovider\u001b[0m", "2026-05-22T10:00:00.000Z"),
    title: "ANSI import",
  };
  await admit(target, ["Saved speech"]);
  expect(await writeNotes(target, "Saved speech")).toBe(
    path.join(store.sessionDir(target), "summary.md"),
  );
  const artifacts = await store.materializeSessionArtifacts({ ...target, title: "Stale" }, "all");
  expect(readText(artifacts.metadataPath)).toContain(target.title);
  expect(JSON.parse(readText(path.join(artifacts.sessionDir, "summary.json")))).toMatchObject({
    sessionId: target.sessionId,
  });
  expect(readText(artifacts.transcriptPath)).toContain('"text":"Saved speech"');
  await closeDatabase();
  await expect(createStore().readSummary(target)).resolves.toMatchObject({
    summary: { sessionId: target.sessionId },
  });
  updateExports(target, { export_manifest_json: "{}" });
  await Promise.all([
    store.materializeSessionArtifacts(target, "summary"),
    store.materializeSessionArtifacts(target, "transcript"),
  ]);
  const manifest = stateDatabase()
    .prepare("SELECT export_manifest_json FROM meeting_transcript_sessions WHERE session_id = ?")
    .get(target.sessionId) as { export_manifest_json: string };
  expect(JSON.parse(manifest.export_manifest_json)).toMatchObject({
    "metadata.json": expect.any(String),
    "summary.md": expect.any(String),
    "transcript.jsonl": expect.any(String),
  });
  fs.appendFileSync(artifacts.transcriptPath, '{"text":"external edit"}\n');
  const updated = { ...target, stoppedAt: "2026-07-01T11:00:00.000Z" };
  await expect(store.writeSession(updated)).resolves.toMatchObject({
    inserted: false,
    inputRevision: expect.any(String),
  });
  expect(await store.readSession(target.sessionId)).toEqual(updated);
  await writeNotes(target, "Updated notes");
  expect((await store.readSummary(target)).summary?.overview).toBe("Updated notes");
  await expect(store.materializeSessionArtifacts(target, "transcript")).rejects.toThrow(
    "run openclaw doctor --fix",
  );
  const missing = session("phantom-export");
  await expect(store.materializeSessionArtifacts(missing, "metadata")).rejects.toThrow(
    "transcripts session not found",
  );
  expect(fs.existsSync(store.sessionDir(missing))).toBe(false);
});
