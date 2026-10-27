import { existsSync } from "node:fs";
import path from "node:path";
import { DatabaseSync, StatementSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import { TRANSCRIPTS_RESULT_MAX_BYTES } from "../../packages/gateway-protocol/src/schema/transcripts.js";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import {
  executeOpenClawStateWorker,
  runOpenClawStateWorkerOperation,
} from "../state/openclaw-state-worker-store.js";
import { withoutMainThreadSql as withoutParentSql } from "../test-utils/main-thread-sql-spies.test-support.js";
import { useStateDatabaseTempDirs } from "../test-utils/state-database-temp-dirs.js";
import { persistTranscriptSummary } from "../transcripts/capture-summary.js";
import { resolveTranscriptsConfig } from "../transcripts/config.js";
import {
  exportTranscriptLibrary,
  getTranscriptLibrary,
  listTranscriptLibrary,
} from "../transcripts/library.js";
import type {
  TranscriptSessionDescriptor,
  TranscriptUtterance,
} from "../transcripts/provider-types.js";
import { readTranscriptLibraryStatus } from "../transcripts/status.js";
import {
  TranscriptSessionConflictError,
  TranscriptsSummaryChangedError,
} from "../transcripts/store-errors.js";
import * as exportOwnership from "../transcripts/store-export-ownership.js";
import { TranscriptLibraryError } from "../transcripts/store-read.js";
import { TranscriptsStore, transcriptSessionSelector } from "../transcripts/store.js";
import { summarizeTranscripts } from "../transcripts/summary.js";
import { requireNodeSqlite } from "./node-sqlite.js";
import * as workerAdmission from "./sqlite-worker-operation-admission.js";
import { sqliteWorkerOwnerProbe as probe } from "./sqlite-worker-owner-probe.test-support.js";

const dirs = useStateDatabaseTempDirs();

function fixture() {
  const stateDir = dirs.make("transcript-worker-");
  const env = { OPENCLAW_STATE_DIR: stateDir };
  const exportRoot = path.join(stateDir, "transcripts");
  return { env, exportRoot, store: new TranscriptsStore(exportRoot, { env }) };
}

function sessionFixture(
  sessionId: string,
  overrides: Partial<TranscriptSessionDescriptor> = {},
): TranscriptSessionDescriptor {
  return {
    sessionId,
    startedAt: "2026-09-21T12:00:00.000Z",
    source: { providerId: "manual-transcript" },
    ...overrides,
  };
}

async function closeDatabase() {
  await closeOpenClawStateDatabaseAsync();
  closeOpenClawStateDatabaseForTest();
}

function storedUtterances(session: TranscriptSessionDescriptor, utterances: TranscriptUtterance[]) {
  return utterances.map((utterance) => ({ ...utterance, sessionId: session.sessionId }));
}

async function expectReceipt(
  store: TranscriptsStore,
  session: TranscriptSessionDescriptor,
  receipt: Awaited<ReturnType<TranscriptsStore["writeSession"]>>,
  inserted: boolean,
) {
  const revision = await store.readSummaryInputRevision(session);
  expect(receipt).toEqual({ inserted, inputRevision: revision, sessionRevision: revision });
  return revision;
}

async function seed(
  store: TranscriptsStore,
  session: TranscriptSessionDescriptor,
  utterances: TranscriptUtterance[] = [],
  summary = false,
) {
  await store.writeSession(session);
  for (const utterance of utterances) {
    await store.appendUtteranceForSession(session, utterance);
  }
  const notes = summarizeTranscripts({ session, utterances });
  if (summary) {
    await store.writeSummary(notes, session);
  }
  await closeDatabase();
  return notes;
}

function persist(
  store: TranscriptsStore,
  session: TranscriptSessionDescriptor,
  env: { OPENCLAW_STATE_DIR: string },
  assertCurrent?: () => void,
) {
  return persistTranscriptSummary({
    store,
    session,
    stateDir: env.OPENCLAW_STATE_DIR,
    config: resolveTranscriptsConfig(undefined),
    assertCurrent,
  });
}

function retireAt(stage: workerAdmission.SqliteWorkerAdmissionRequest["stage"]) {
  const failure = new TranscriptsSummaryChangedError();
  const requests: workerAdmission.SqliteWorkerAdmissionRequest["stage"][] = [];
  let current = true;
  const observer = probe.admission(workerAdmission, (request, grant, admit) => {
    requests.push(request.stage);
    if (request.stage === stage) {
      current = false;
    }
    admit(request, grant);
  });
  return {
    failure,
    requests,
    observer,
    assertCurrent: () => {
      if (!current) {
        throw failure;
      }
    },
  };
}

async function withoutParentTranscriptSql(operation: () => Promise<void>) {
  const prepared = new WeakSet<StatementSync>();
  const observed: { databasePath: string | null; sql?: unknown }[] = [];
  function record(database: DatabaseSync, sql?: unknown) {
    observed.push({ databasePath: database.location(), sql });
  }
  function observe<T extends (...args: never[]) => unknown>(method: T): T {
    return new Proxy(method, {
      apply(target, database, args) {
        record(database, args[0]);
        const result: unknown = Reflect.apply(target, database, args);
        if (result instanceof StatementSync) {
          prepared.add(result);
        }
        return result;
      },
    });
  }
  const sqlite = requireNodeSqlite();
  const originalConstructor = sqlite.DatabaseSync;
  sqlite.DatabaseSync = new Proxy(originalConstructor, {
    construct(target, args, newTarget) {
      const database: DatabaseSync = Reflect.construct(target, args, newTarget);
      record(database);
      return database;
    },
  });
  const prepare = vi.spyOn(DatabaseSync.prototype, "prepare");
  const exec = vi.spyOn(DatabaseSync.prototype, "exec");
  const close = vi.spyOn(DatabaseSync.prototype, "close");
  DatabaseSync.prototype.prepare = observe(prepare);
  DatabaseSync.prototype.exec = observe(exec);
  DatabaseSync.prototype.close = observe(close);
  const statements = (["get", "all", "run", "iterate"] as const).map((method) =>
    vi.spyOn(StatementSync.prototype, method),
  );
  const calls = [prepare, exec, close, ...statements];
  try {
    await operation();
    for (const statement of statements) {
      for (const receiver of statement.mock.contexts) {
        expect(
          receiver instanceof StatementSync && prepared.has(receiver),
          "unattributed caller-thread SQLite statement",
        ).toBe(true);
      }
    }
    for (const entry of observed) {
      expect(entry.databasePath, "caller-thread file-backed SQLite activity").toBeNull();
      if (entry.sql !== undefined) {
        expect(entry.sql).toMatch(/^SELECT sqlite_version\(\) AS version, /u);
      }
    }
  } finally {
    sqlite.DatabaseSync = originalConstructor;
    for (const call of calls) {
      call.mockRestore();
    }
  }
}

it("keeps cold transcript reads on the canonical worker and preserves store creation", async () => {
  const { env, exportRoot, store } = fixture();
  const databasePath = resolveOpenClawStateSqlitePath(env);
  expect(existsSync(databasePath)).toBe(false);
  await withoutParentSql(async () => {
    expect([
      await listTranscriptLibrary(store, { limit: 2 }),
      await store.listReadEntries({ limit: 2 }),
      await store.listSessionEntries(),
      await store.readLatestEntry(),
      await store.readSession("missing"),
      await executeOpenClawStateWorker(captureOpenClawStateWorkerContext({ env }), {
        type: "claws.install-schema-versions",
        input: { artifactPreservingReadOnly: true },
      }),
    ]).toEqual([
      { sessions: [], nextCursor: null },
      { entries: [], hasMore: false },
      [],
      undefined,
      undefined,
      [],
    ]);
  });
  expect([existsSync(databasePath), existsSync(exportRoot)]).toEqual([true, false]);
});

it("reads cold and warm public pages off thread with tied dates and private sources", async () => {
  const { store } = fixture();
  for (const sessionId of ["a", "b"]) {
    await store.writeSession(
      sessionFixture(sessionId, {
        source: { providerId: "manual-transcript", private: "synthetic-private" },
        metadata: { agentId: "main", private: "synthetic-metadata" },
      }),
    );
  }
  await closeDatabase();
  await withoutParentSql(async () => {
    const first = await listTranscriptLibrary(store, { limit: 1 }, () => "Manual");
    expect(first.sessions).toMatchObject([
      { sessionId: "a", providerName: "Manual", agentId: "main" },
    ]);
    expect(first.nextCursor).not.toBeNull();
    const second = await listTranscriptLibrary(store, { limit: 1, cursor: first.nextCursor! });
    expect(second).toMatchObject({ sessions: [{ sessionId: "b" }], nextCursor: null });
    expect(JSON.stringify([first, second])).not.toContain("synthetic-");
  });
});

it("appends immutable speech on the canonical worker with exact-id deduplication and sequence order", async () => {
  const { store } = fixture();
  const session = sessionFixture("append-worker", {
    metadata: { hostOnly: () => undefined },
  });
  await seed(store, session);
  const original = {
    id: "first",
    text: "First speech",
    speaker: { id: "speaker", label: "Sam" },
    metadata: { language: "en", nested: [1, null, "🦞"] },
    final: true,
  } satisfies TranscriptUtterance;
  const toJSON = vi.fn(() => structuredClone(original.metadata));
  const utterance = { ...original, speaker: { ...original.speaker }, metadata: { toJSON } };
  await withoutParentTranscriptSql(async () => {
    const writing = store.appendUtteranceForSession(session, utterance);
    utterance.text = "Caller changed speech";
    utterance.speaker!.label = "Caller changed speaker";
    await writing;
    await store.appendUtteranceForSession(session, structuredClone(original));
    await store.appendUtteranceForSession(session, { text: "Second speech" });
  });
  expect(toJSON).toHaveBeenCalledOnce();
  expect(await store.readUtterancesForSession(session)).toEqual(
    storedUtterances(session, [original, { text: "Second speech" }]),
  );
  const revision = await store.readSummaryInputRevision(session);
  expect(JSON.parse(revision!).next_utterance_seq).toBe(2);
  await closeDatabase();
  expect((await store.readUtterancesForSession(session)).map((entry) => entry.text)).toEqual([
    "First speech",
    "Second speech",
  ]);
});

it("persists session metadata off thread with typed conflicts and durable ID origin", async () => {
  const { store } = fixture();
  const session = sessionFixture("session-worker", {
    metadata: { sessionIdOrigin: "generated", ignored: () => "host-only", label: "雪" },
  });
  await withoutParentTranscriptSql(async () => {
    const inserted = await store.writeSession(session);
    const revision = await expectReceipt(store, session, inserted, true);
    await store.appendUtteranceForSession(session, { text: "Retained speech" });
    const updated = await store.writeSession(
      { ...session, title: "Updated", metadata: { label: "é" } },
      { expectedSessionRevision: inserted.sessionRevision },
    );
    const updatedRevision = await store.readSummaryInputRevision(session);
    expect(updated).toEqual({
      inserted: false,
      inputRevision: updatedRevision,
      sessionRevision: JSON.stringify({ ...JSON.parse(updatedRevision!), next_utterance_seq: 0 }),
    });
    await expect(
      store.writeSession(
        { ...session, title: "Stale descriptor" },
        { expectedSessionRevision: inserted.sessionRevision },
      ),
    ).rejects.toBeInstanceOf(TranscriptsSummaryChangedError);
    expect(JSON.parse(updated.inputRevision).next_utterance_seq).toBe(1);
    await expect(
      store.writeSession({ ...session, title: "Stale" }, { expectedInputRevision: revision }),
    ).rejects.toBeInstanceOf(TranscriptsSummaryChangedError);
    await expect(
      store.writeSession({ ...session, startedAt: "2026-09-21T13:00:00.000Z" }),
    ).rejects.toBeInstanceOf(TranscriptSessionConflictError);
  });
  await closeDatabase();
  expect(await store.readSession(session.sessionId)).toMatchObject({
    title: "Updated",
    metadata: { sessionIdOrigin: "generated", label: "é" },
  });
});

it("returns SQLite-normalized text in the committed session receipt", async () => {
  const { store } = fixture();
  const session = sessionFixture("normalized-receipt", {
    startedAt: "2026-10-04T12:00:00.000Z",
    stoppedAt: "2026-10-04T12:00:01.000Z",
    title: "Unpaired \ud800",
  });
  const inserted = await store.writeSession(session);
  await expectReceipt(store, session, inserted, true);
  const updated = await store.writeSession(
    { ...session, title: "Changed \udfff" },
    { expectedInputRevision: inserted.inputRevision },
  );
  await expectReceipt(store, session, updated, false);
  await store.deleteEmptySessionCandidate(session, {
    expectedInputRevision: updated.inputRevision,
    assertCurrent: () => undefined,
  });
  expect(await store.readSession(session.sessionId)).toBeUndefined();
});

it("retains the captured session input and database through export preparation", async () => {
  const { env, exportRoot, store } = fixture();
  const originalStateDir = env.OPENCLAW_STATE_DIR;
  const otherStateDir = dirs.make("transcript-other-worker-");
  const session = sessionFixture("captured-session", {
    title: "Captured title",
    source: { providerId: "manual-transcript", accountId: "original" },
    metadata: { label: "original" },
  });
  const selected = createDeferred();
  const resume = createDeferred();
  const ownership = exportOwnership.hasAliasedCanonicalTranscriptExportPathOwner;
  const observer = vi
    .spyOn(exportOwnership, "hasAliasedCanonicalTranscriptExportPathOwner")
    .mockImplementation(async (...args) => {
      selected.resolve();
      await resume.promise;
      return ownership(...args);
    });
  const pending = store.writeSession(session);
  try {
    await selected.promise;
    env.OPENCLAW_STATE_DIR = otherStateDir;
    session.title = "Changed title";
    session.source.accountId = "changed";
    session.metadata = { label: "changed" };
    resume.resolve();
    await pending;
  } finally {
    resume.resolve();
    await Promise.allSettled([pending]);
    observer.mockRestore();
  }
  const originalStore = new TranscriptsStore(exportRoot, {
    env: { OPENCLAW_STATE_DIR: originalStateDir },
  });
  expect(await originalStore.readSession("captured-session")).toMatchObject({
    title: "Captured title",
    source: { accountId: "original" },
    metadata: { label: "original" },
  });
  expect(existsSync(resolveOpenClawStateSqlitePath(env))).toBe(false);
});

it("publishes captured summary notes without caller-thread transcript SQL", async () => {
  const { env, store } = fixture();
  const session = sessionFixture("summary-worker");
  await seed(store, session, [{ text: "We agreed to simplify setup." }]);
  await withoutParentTranscriptSql(async () => {
    const result = await persist(store, session, env);
    expect(result.summary.transcript).toEqual(["We agreed to simplify setup."]);
  });
  expect(await store.readSummary(session)).toMatchObject({
    summary: { transcript: ["We agreed to simplify setup."], utteranceCount: 1 },
    markdown: expect.stringContaining("We agreed to simplify setup."),
  });
});

it.each(
  (["discard", "session", "summary"] as const).flatMap((operation) =>
    (["transaction", "commit"] as const).map((stage) => ({ operation, stage })),
  ),
)(
  "retains prior $operation data when its owner retires at the worker $stage grant",
  async ({ operation, stage }) => {
    const { env, store } = fixture();
    const session = sessionFixture(`${operation}-revoked-${stage}`, {
      startedAt: "2026-09-20T12:00:00.000Z",
      ...(operation === "discard" ? { stoppedAt: "2026-09-20T12:00:01.000Z" } : {}),
      title: "Original",
    });
    await store.writeSession(session);
    const expectedInputRevision = await store.readSummaryInputRevision(session);
    if (expectedInputRevision === undefined) {
      throw new Error("Expected stored transcript admission");
    }
    if (operation === "summary") {
      await store.appendUtteranceForSession(session, { text: "Fresh captured speech" });
      await store.writeSummary(
        summarizeTranscripts({ session, utterances: [{ text: "Retained earlier notes" }] }),
        session,
      );
    }
    const previous = operation === "summary" ? await store.readSummary(session) : undefined;
    const { failure, requests, observer, assertCurrent } = retireAt(stage);
    try {
      await expect(
        operation === "discard"
          ? store.deleteEmptySessionCandidate(session, { expectedInputRevision, assertCurrent })
          : operation === "session"
            ? store.writeSession({ ...session, title: "Retired update" }, { assertCurrent })
            : persist(store, session, env, assertCurrent),
      ).rejects.toBe(failure);
    } finally {
      observer.mockRestore();
    }
    expect(requests).toContain(stage);
    if (operation !== "summary") {
      expect(await store.readSession(session.sessionId)).toEqual(session);
    } else {
      expect(await store.readSummary(session)).toEqual(previous);
    }
  },
);

it("returns complete stored reads and typed errors after existing-only status and reopen", async () => {
  const { env, store } = fixture();
  const databasePath = resolveOpenClawStateSqlitePath(env);
  const readStatus = () =>
    runOpenClawStateWorkerOperation(
      captureOpenClawStateWorkerContext({ env }),
      (scope) =>
        scope.execute({
          type: "plugins.conversationBindingApprovals.read",
          input: undefined,
        }),
      { existingOnly: true },
    );
  await withoutParentSql(async () => {
    expect(await readStatus()).toBeUndefined();
  });
  expect(existsSync(databasePath)).toBe(false);

  const session = sessionFixture("worker-meeting", {
    source: { providerId: "manual-transcript", accountId: "synthetic" },
    title: "Worker meeting",
    startedAt: "2026-09-12T10:00:00.000Z",
    stoppedAt: "2026-09-12T11:00:00.000Z",
    metadata: { agentId: "main", sessionIdOrigin: "generated", nested: { values: [1, null] } },
  });
  const utterances: TranscriptUtterance[] = Array.from({ length: 20 }, (_, index) => ({
    id: `utterance-${index}`,
    text: `Meeting text ${index} 🦞\n`,
    speaker: { id: "speaker", label: "Speaker" },
    final: true,
    metadata: { index },
  }));
  const summary = await seed(store, session, utterances, true);

  const selector = transcriptSessionSelector(session);
  await withoutParentSql(async () => {
    expect(await readStatus()).toEqual([]);
    expect(await store.readSession(selector)).toEqual(session);
    expect(await store.listSessionEntries()).toMatchObject([
      { session, selector, hasSummary: true },
    ]);
    const matches = await store.matchSessionEntries(session.sessionId);
    expect(matches).toMatchObject({
      qualified: [],
      unqualified: [{ session, selector, hasSummary: true }],
    });
    const revision = await store.readSummaryInputRevision(session);
    expect(JSON.parse(revision!).next_utterance_seq).toBe(utterances.length);
    expect(
      await store.readRecentStoppedSession(
        session.source,
        "2026-09-12T10:59:00.000Z",
        "2026-09-12T11:01:00.000Z",
      ),
    ).toEqual({ session, inputRevision: revision });
    expect(await store.readUtterancesForSession(session)).toEqual(
      storedUtterances(session, utterances),
    );
    expect((await store.readSummarySnapshot(session, 3))?.utterances).toEqual(
      storedUtterances(session, utterances.slice(-3)),
    );
    expect((await store.readSummary(session)).summary).toEqual(summary);
    const { transcript: _transcript, ...notes } = summary;
    const withHostOnlyMetadata = { ...session, metadata: { callback: () => undefined } };
    expect((await store.readNotes(withHostOnlyMetadata)).summary).toEqual(notes);
    for (const entry of [await store.readEntry(selector), await store.readLatestEntry()]) {
      expect(entry).toMatchObject({ session, selector, utteranceCount: 20 });
    }
    const page = await getTranscriptLibrary(store, { selector, includeUtterances: true, limit: 2 });
    expect(page.utterances).toMatchObject([
      { sequence: 0, text: "Meeting text 0 🦞\\n", speakerLabel: "Speaker" },
      { sequence: 1, text: "Meeting text 1 🦞\\n", speakerLabel: "Speaker" },
    ]);
    expect(page.nextCursor).not.toBeNull();
    expect((await readTranscriptLibraryStatus(store, {})).latestTranscript?.selector).toBe(
      selector,
    );
    await expect(getTranscriptLibrary(store, { selector: "missing" })).rejects.toBeInstanceOf(
      TranscriptLibraryError,
    );
    await expect(
      getTranscriptLibrary(store, { selector, cursor: "invalid" }),
    ).rejects.toMatchObject({ type: "transcript_invalid_cursor" });
    expect(
      await executeOpenClawStateWorker(captureOpenClawStateWorkerContext({ env }), {
        type: "transcripts.session",
        input: {
          params: { session: { sessionId: session.sessionId, startedAt: session.startedAt } },
        },
      }),
    ).toEqual({ ok: true, value: session });
  });
  await closeDatabase();
  await withoutParentSql(async () => {
    expect((await store.readSummary(session)).summary).toEqual(summary);
    expect(await store.readSession(selector)).toEqual(session);
    expect(await store.readUtterancesForSession(session)).toEqual(
      storedUtterances(session, utterances),
    );
  });
  await store.writeSession({ ...session, title: "x".repeat(TRANSCRIPTS_RESULT_MAX_BYTES + 1) });
  await withoutParentSql(async () => {
    const result = store.readEntry(selector);
    await expect(result).rejects.toBeInstanceOf(TranscriptLibraryError);
    await expect(result).rejects.toMatchObject({
      type: "transcript_result_too_large",
      maxBytes: TRANSCRIPTS_RESULT_MAX_BYTES,
    });
  });
});

it("exports cold and warm library rows and notes without caller-thread SQLite", async () => {
  const { store } = fixture();
  const session = sessionFixture("export-worker", {
    title: "Export meeting",
  });
  const utterance = {
    text: "Saved speech",
    speaker: { label: "Sam" },
    metadata: { private: true },
  };
  await seed(store, session, [utterance], true);
  const selector = transcriptSessionSelector(session);
  await withoutParentSql(async () => {
    for (const format of ["jsonl", "markdown", "jsonl"] as const) {
      const exported = await exportTranscriptLibrary(store, { selector, format });
      const text = Buffer.from(exported.data, "base64").toString("utf8");
      expect(text).toContain("Saved speech");
      expect(text).not.toContain("private");
      if (format === "markdown") {
        expect(text).toContain("Export meeting");
        expect(text).toContain("Sam");
      } else {
        expect(JSON.parse(text)).toEqual({
          sequence: 0,
          text: "Saved speech",
          speakerLabel: "Sam",
        });
      }
    }
    await expect(
      exportTranscriptLibrary(store, { selector: "missing", format: "jsonl" }),
    ).rejects.toMatchObject({ type: "transcript_session_not_found" });
  });
});
