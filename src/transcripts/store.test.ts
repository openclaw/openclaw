import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
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

it("reuses list pages without worker requests and observes another store's writes", async () => {
  const writer = createStore();
  const target = { ...session(), title: "Initial title" };
  await writer.writeSession(target);
  const options = { limit: 50, projection: "public" } as const;
  const page = async (reader = store) => (await reader.listReadEntries(options)).entries;
  const initial = await page();
  expect(initial).toMatchObject([{ title: "Initial title", utteranceCount: 0 }]);
  initial[0]!.title = "Caller mutation";

  const requests = vi.spyOn(Worker.prototype, "postMessage");
  const sql = observeMainThreadSql();
  try {
    expect(await page(createStore())).toMatchObject([
      { title: "Initial title", utteranceCount: 0 },
    ]);
    expect(requests).not.toHaveBeenCalled();
    sql.expectIdle();

    await writer.writeSession({ ...target, title: "Updated title" });
    expect(await page()).toMatchObject([{ title: "Updated title", utteranceCount: 0 }]);
    await writer.appendUtteranceForSession(target, { text: "New speech", final: true });
    expect(await page()).toMatchObject([{ title: "Updated title", utteranceCount: 1 }]);
    expect((await store.listReadEntries({ ...options, query: "absent" })).entries).toEqual([]);
    expect(await page()).toHaveLength(1);
    sql.expectIdle();
  } finally {
    requests.mockRestore();
    sql.restore();
  }
});

it.each(["empty", "speech", "summary", "export", "pending export", "rewritten"] as const)(
  "discards only unchanged empty failed admissions (%s)",
  async (state) => {
    const target = { ...session("abandoned"), stoppedAt: "2026-07-01T10:00:01.000Z" };
    await store.writeSession(target);
    const expectedInputRevision = await store.readSummaryInputRevision(target);
    if (expectedInputRevision === undefined) {
      throw new Error("Expected admitted transcript");
    }
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

it("keeps selector and overview columns aligned on insert, replacement, and removal", async () => {
  const fields = [
    ["accountId", "source_account_id", "account"],
    ["guildId", "source_guild_id", "guild"],
    ["channelId", "source_channel_id", "channel"],
    ["meetingUrl", "source_meeting_url", "https://example.test/meeting"],
    ["threadTs", "source_thread_ts", "thread"],
    ["fileId", "source_file_id", "file"],
  ] as const;
  const columnValues = (empty = false) =>
    Object.fromEntries(fields.map(([, column, value]) => [column, empty ? null : value]));
  const target = {
    ...session(),
    source: {
      providerId: "manual-transcript",
      ...Object.fromEntries(fields.map(([key, , value]) => [key, value])),
    },
    metadata: { agentId: "agent" },
  };
  const readColumns = () =>
    stateDatabase()
      .prepare(
        `SELECT ${fields.map(([, column]) => column).join(", ")}, metadata_agent_id
         FROM meeting_transcript_sessions WHERE session_id = ? AND started_at = ?`,
      )
      .get(target.sessionId, target.startedAt);
  await store.writeSession(target);
  expect(readColumns()).toEqual({ ...columnValues(), metadata_agent_id: "agent" });
  await store.writeSession({
    ...target,
    source: { providerId: "manual-transcript", accountId: "replacement" },
    metadata: {},
  });
  expect(readColumns()).toEqual({
    ...columnValues(true),
    source_account_id: "replacement",
    metadata_agent_id: null,
  });
  const summary = summarizeTranscripts({ session: target, utterances: [] });
  await store.writeSummary({ ...summary, overview: "Initial overview" }, target);
  await store.writeSummary({ ...summary, overview: "Replacement overview" }, target);
  expect(
    stateDatabase()
      .prepare("SELECT overview FROM meeting_transcript_summaries WHERE session_id = ?")
      .get(target.sessionId),
  ).toEqual({ overview: "Replacement overview" });
});

it("keeps summary snapshot queries bound to the current session and persisted revision", async () => {
  const first = session("summary-first");
  const second = { ...session("summary-second"), title: "Second meeting" };
  const later = session("summary-first", "2026-07-02T10:00:00.000Z");
  await admit(first, ["First speech"]);
  await admit(second, ["Second speech"]);
  await admit(later, ["Next day speech"]);
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
    const target = { ...session(), title: "Original meeting" };
    await store.writeSession(target);
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
      expect(stored?.metadata?.sessionIdOrigin, target.sessionId).toEqual(origin);
      expect(stored?.metadata?.agentId, target.sessionId).toBe(metadata?.agentId);
      expect(Object.hasOwn(stored?.metadata ?? {}, "sessionIdOrigin"), target.sessionId).toBe(
        origin !== undefined,
      );
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
  const target = session();
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
  await store.writeSession(target);
  await appendEach(target, revisions, 2);
  await appendEach(target, revisions);
  await expect(store.readUtterancesForSession(target)).resolves.toEqual(
    revisions.map((revision) => Object.assign({ sessionId: target.sessionId }, revision)),
  );

  for (const other of [session("other"), session(target.sessionId, "2026-07-02T10:00:00.000Z")]) {
    await store.writeSession(other);
    await store.appendUtteranceForSession(other, interim);
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

it.each(["standup"])("requires dated selectors for repeated %s", async (id) => {
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

it("does not let a modified export block canonical session updates", async () => {
  const target = await admit(session("mutable-export"), ["canonical"]);
  const artifacts = await store.materializeSessionArtifacts(target, "transcript");
  fs.appendFileSync(artifacts.transcriptPath, '{"text":"external edit"}\n');

  await expect(
    store.writeSession({ ...target, stoppedAt: "2026-07-01T11:00:00.000Z" }),
  ).resolves.toMatchObject({ inserted: false, inputRevision: expect.any(String) });
  await expect(store.readSession(target.sessionId)).resolves.toMatchObject({
    stoppedAt: "2026-07-01T11:00:00.000Z",
  });
  await expect(writeNotes(target, "canonical")).resolves.toBe(
    path.join(store.sessionDir(target), "summary.md"),
  );
  await expect(store.readSummary(target)).resolves.toMatchObject({
    summary: { sessionId: target.sessionId },
  });
  await expect(store.materializeSessionArtifacts(target, "transcript")).rejects.toThrow(
    "run openclaw doctor --fix",
  );
});

it("resolves descriptor exports through canonical SQLite identity", async () => {
  const target = { ...session("canonical-export"), title: "Canonical title" };
  await store.writeSession(target);

  const artifacts = await store.materializeSessionArtifacts(
    { ...target, title: "Stale title" },
    "metadata",
  );

  expect(readText(artifacts.metadataPath)).toContain("Canonical title");
  await expect(
    store.materializeSessionArtifacts(session("phantom-export"), "metadata"),
  ).rejects.toThrow("transcripts session not found");
  expect(fs.existsSync(store.sessionDir(session("phantom-export")))).toBe(false);
});

it("stores summaries in SQLite and materializes artifacts beneath a shared export parent", async () => {
  const exportRoot = path.join(suiteStateDir, "transcripts");
  fs.mkdirSync(exportRoot, { recursive: true });
  fs.chmodSync(exportRoot, 0o770);
  const target = {
    ...session("ansi-\u001b[31mprovider\u001b[0m", "2026-05-22T10:00:00.000Z"),
    title: "ANSI import",
  };
  const utterance = { text: "We decided to ship the CLI.", speaker: { label: "Sam" } };
  await admit(target, [utterance]);
  const summary = summarizeTranscripts({ session: target, utterances: [utterance] });
  const markdownPath = await store.writeSummary(summary, target);
  const artifacts = await store.materializeSessionArtifacts(target, "all");

  expect(markdownPath).toBe(path.join(store.sessionDir(target), "summary.md"));
  expect(JSON.parse(readText(path.join(artifacts.sessionDir, "summary.json")))).toMatchObject({
    sessionId: target.sessionId,
  });
  expect(readText(artifacts.transcriptPath)).toContain('"text":"We decided to ship the CLI."');
  await closeDatabase();
  const reopened = createStore();
  await expect(reopened.readSummary(target)).resolves.toMatchObject({
    summary: { sessionId: target.sessionId },
  });
});

it("repairs an interrupted manifest update and serializes concurrent exports", async () => {
  const target = await admit(session("recover-export"), ["recover me"]);
  await writeNotes(target, "recover me");
  await store.materializeSessionArtifacts(target, "all");
  updateExports(target, { export_manifest_json: "{}" });

  await expect(
    Promise.all([
      store.materializeSessionArtifacts(target, "summary"),
      store.materializeSessionArtifacts(target, "transcript"),
    ]),
  ).resolves.toHaveLength(2);

  const manifest = stateDatabase()
    .prepare("SELECT export_manifest_json FROM meeting_transcript_sessions WHERE session_id = ?")
    .get(target.sessionId) as { export_manifest_json: string };
  expect(JSON.parse(manifest.export_manifest_json)).toMatchObject({
    "metadata.json": expect.any(String),
    "summary.md": expect.any(String),
    "transcript.jsonl": expect.any(String),
  });
});
