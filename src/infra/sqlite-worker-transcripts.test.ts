import { existsSync, realpathSync } from "node:fs";
import path from "node:path";
import { DatabaseSync, StatementSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { TRANSCRIPTS_RESULT_MAX_BYTES } from "../../packages/gateway-protocol/src/schema/transcripts.js";
import { createDeferred } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
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
import { persistTranscriptSummary } from "../transcripts/capture-summary.js";
import { resolveTranscriptsConfig } from "../transcripts/config.js";
import { getTranscriptLibrary } from "../transcripts/library.js";
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
import { openNodeSqliteDatabase, requireNodeSqlite } from "./node-sqlite.js";
import * as workerAdmission from "./sqlite-worker-operation-admission.js";
import {
  resolveStateDatabaseCoordinatorPath,
  resolveStateLifecycleRuntimeDirectory,
} from "./state-database-coordinator.js";

const dirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    vi.restoreAllMocks();
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
    cleanup();
  }),
);

function fixture() {
  const stateDir = dirs.make("transcript-worker-");
  const env = { OPENCLAW_STATE_DIR: stateDir };
  const exportRoot = path.join(stateDir, "transcripts");
  return { env, exportRoot, store: new TranscriptsStore(exportRoot, { env }) };
}

async function withoutParentSql<T>(operation: () => Promise<T>): Promise<T> {
  const prepare = vi.spyOn(DatabaseSync.prototype, "prepare");
  const exec = vi.spyOn(DatabaseSync.prototype, "exec");
  const statements = (["get", "all", "run", "iterate"] as const).map((method) =>
    vi.spyOn(StatementSync.prototype, method),
  );
  try {
    const result = await operation();
    expect(prepare.mock.calls.length, "parent prepare calls").toBe(0);
    expect(exec.mock.calls.length, "parent exec calls").toBe(0);
    for (const statement of statements) {
      expect(statement.mock.calls.length, "parent statement calls").toBe(0);
    }
    return result;
  } finally {
    prepare.mockRestore();
    exec.mockRestore();
    for (const statement of statements) {
      statement.mockRestore();
    }
  }
}

async function withoutParentTranscriptSql(databasePath: string, operation: () => Promise<void>) {
  type ObservedSql = { databasePath: string | null; sql?: string };
  const observed: ObservedSql[] = [];
  const prepared = new WeakMap<object, ObservedSql>();
  const sqlite = requireNodeSqlite();
  const originalConstructor = sqlite.DatabaseSync;
  let opens = 0;
  sqlite.DatabaseSync = new Proxy(originalConstructor, {
    construct(target, args, newTarget) {
      opens += 1;
      const database: DatabaseSync = Reflect.construct(target, args, newTarget);
      observed.push({ databasePath: database.location() });
      return database;
    },
  });
  const prepare = vi.spyOn(DatabaseSync.prototype, "prepare");
  const exec = vi.spyOn(DatabaseSync.prototype, "exec");
  const close = vi.spyOn(DatabaseSync.prototype, "close");
  DatabaseSync.prototype.prepare = function (this: DatabaseSync, sql: string) {
    const observation = { databasePath: this.location(), sql };
    observed.push(observation);
    const statement = prepare.call(this, sql);
    prepared.set(statement, observation);
    return statement;
  };
  DatabaseSync.prototype.exec = function (this: DatabaseSync, sql: string) {
    observed.push({ databasePath: this.location(), sql });
    return exec.call(this, sql);
  };
  DatabaseSync.prototype.close = function (this: DatabaseSync) {
    observed.push({ databasePath: this.location() });
    return close.call(this);
  };
  const statements = (["get", "all", "run", "iterate"] as const).map((method) =>
    vi.spyOn(StatementSync.prototype, method),
  );
  const calls = [prepare, exec, close, ...statements];
  try {
    const calibration = openNodeSqliteDatabase(":memory:");
    try {
      calibration.exec("SELECT 1");
      const statement = calibration.prepare("SELECT 1 AS value");
      statement.get();
      statement.all();
      statement.run();
      expect([...statement.iterate()]).toEqual([{ value: 1 }]);
    } finally {
      calibration.close();
    }
    expect(opens).toBe(1);
    for (const call of calls) {
      expect(call).toHaveBeenCalled();
      call.mockClear();
    }
    opens = 0;
    observed.length = 0;
    await operation();
    for (const statement of statements) {
      for (const receiver of statement.mock.contexts) {
        const observation = receiver instanceof StatementSync ? prepared.get(receiver) : undefined;
        expect(observation, "unattributed caller-thread SQLite statement").toBeDefined();
        if (observation) {
          observed.push(observation);
        }
      }
    }
    const physicalDatabase = realpathSync(databasePath);
    expect(
      observed.filter(
        (entry) => entry.databasePath && realpathSync(entry.databasePath) === physicalDatabase,
      ),
      "caller-thread transcript database activity",
    ).toEqual([]);
    const coordinatorPath = resolveStateDatabaseCoordinatorPath({
      databasePath,
      runtimeDirectory: resolveStateLifecycleRuntimeDirectory(),
      uid: process.getuid?.(),
    });
    const probes = [
      "SELECT sqlite_version() AS version",
      "SELECT sqlite_compileoption_used('OMIT_LOAD_EXTENSION') AS omitted",
    ];
    const control = [
      "PRAGMA busy_timeout = 0; PRAGMA journal_mode = MEMORY; BEGIN EXCLUSIVE;",
      "ROLLBACK",
    ];
    for (const entry of observed) {
      if (entry.databasePath === null) {
        if (entry.sql !== undefined) {
          expect(probes).toContain(entry.sql);
        }
      } else {
        expect(realpathSync(entry.databasePath)).toBe(realpathSync(coordinatorPath));
        if (entry.sql !== undefined) {
          expect(control).toContain(entry.sql);
        }
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
    expect(await store.listReadEntries({ limit: 2 })).toEqual([]);
    expect(await store.listSessionEntries()).toEqual([]);
    expect(await store.readLatestEntry()).toBeUndefined();
    expect(await store.readSession("missing")).toBeUndefined();
    expect(
      await executeOpenClawStateWorker(captureOpenClawStateWorkerContext({ env }), {
        type: "tasks.get",
        input: { taskId: "missing" },
      }),
    ).toBeUndefined();
  });
  expect(existsSync(databasePath)).toBe(true);
  expect(existsSync(exportRoot)).toBe(false);
});

it("appends immutable speech on the canonical worker with exact-id deduplication and sequence order", async () => {
  const { env, store } = fixture();
  const session: TranscriptSessionDescriptor = {
    sessionId: "append-worker",
    startedAt: "2026-09-18T12:00:00.000Z",
    source: { providerId: "manual-transcript" },
    metadata: { hostOnly: () => undefined },
  };
  await store.writeSession(session);
  await closeOpenClawStateDatabaseAsync();
  closeOpenClawStateDatabaseForTest();
  const toJSON = vi.fn(() => ({ language: "en", nested: [1, null, "🦞"] }));
  const utterance: TranscriptUtterance = {
    id: "first",
    text: "First speech",
    speaker: { id: "speaker", label: "Sam" },
    metadata: { toJSON },
    final: true,
  };
  await withoutParentTranscriptSql(resolveOpenClawStateSqlitePath(env), async () => {
    const writing = store.appendUtteranceForSession(session, utterance);
    utterance.text = "Caller changed speech";
    utterance.speaker!.label = "Caller changed speaker";
    await writing;
    await store.appendUtteranceForSession(session, {
      id: "first",
      text: "First speech",
      speaker: { id: "speaker", label: "Sam" },
      metadata: { language: "en", nested: [1, null, "🦞"] },
      final: true,
    });
    await store.appendUtteranceForSession(session, { text: "Second speech" });
  });
  expect(toJSON).toHaveBeenCalledOnce();
  expect(await store.readUtterancesForSession(session)).toEqual([
    {
      id: "first",
      sessionId: session.sessionId,
      text: "First speech",
      speaker: { id: "speaker", label: "Sam" },
      metadata: { language: "en", nested: [1, null, "🦞"] },
      final: true,
    },
    { sessionId: session.sessionId, text: "Second speech" },
  ]);
  const revision = await store.readSummaryInputRevision(session);
  expect(JSON.parse(revision!).next_utterance_seq).toBe(2);
  await closeOpenClawStateDatabaseAsync();
  closeOpenClawStateDatabaseForTest();
  expect((await store.readUtterancesForSession(session)).map((entry) => entry.text)).toEqual([
    "First speech",
    "Second speech",
  ]);
});

it("persists session metadata off thread with typed conflicts and durable ID origin", async () => {
  const { env, store } = fixture();
  const session: TranscriptSessionDescriptor = {
    sessionId: "session-worker",
    startedAt: "2026-09-21T12:00:00.000Z",
    source: { providerId: "manual-transcript" },
    metadata: { sessionIdOrigin: "generated", ignored: () => "host-only", label: "雪" },
  };
  await withoutParentTranscriptSql(resolveOpenClawStateSqlitePath(env), async () => {
    await store.writeSession(session);
    const revision = await store.readSummaryInputRevision(session);
    await store.writeSession({ ...session, title: "Updated", metadata: { label: "é" } });
    await expect(
      store.writeSession({ ...session, title: "Stale" }, { expectedInputRevision: revision }),
    ).rejects.toBeInstanceOf(TranscriptsSummaryChangedError);
    await expect(
      store.writeSession({ ...session, startedAt: "2026-09-21T13:00:00.000Z" }),
    ).rejects.toBeInstanceOf(TranscriptSessionConflictError);
  });
  await closeOpenClawStateDatabaseAsync();
  closeOpenClawStateDatabaseForTest();
  expect(await store.readSession(session.sessionId)).toMatchObject({
    title: "Updated",
    metadata: { sessionIdOrigin: "generated", label: "é" },
  });
});

it("retains the captured session input and database through export preparation", async () => {
  const { env, exportRoot, store } = fixture();
  const originalStateDir = env.OPENCLAW_STATE_DIR;
  const otherStateDir = dirs.make("transcript-other-worker-");
  const session: TranscriptSessionDescriptor = {
    sessionId: "captured-session",
    title: "Captured title",
    startedAt: "2026-09-21T12:00:00.000Z",
    source: { providerId: "manual-transcript", accountId: "original" },
    metadata: { label: "original" },
  };
  const selected = createDeferred();
  const resume = createDeferred();
  const ownership = exportOwnership.hasAliasedCanonicalTranscriptExportPathOwner;
  const observer = vi
    .spyOn(exportOwnership, "hasAliasedCanonicalTranscriptExportPathOwner")
    .mockImplementation(
      new Proxy(ownership, {
        async apply(target, receiver, args) {
          selected.resolve();
          await resume.promise;
          return Reflect.apply(target, receiver, args);
        },
      }),
    );
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

it.each(["transaction", "commit"] as const)(
  "keeps session metadata unchanged when its owner retires at the worker %s grant",
  async (stage) => {
    const { store } = fixture();
    const session: TranscriptSessionDescriptor = {
      sessionId: `session-revoked-${stage}`,
      startedAt: "2026-09-21T12:00:00.000Z",
      source: { providerId: "manual-transcript" },
      title: "Original",
    };
    await store.writeSession(session);
    let current = true;
    const failure = new TranscriptsSummaryChangedError();
    const createAdmission = workerAdmission.createSqliteWorkerOperationAdmission;
    const observer = vi
      .spyOn(workerAdmission, "createSqliteWorkerOperationAdmission")
      .mockImplementation((admit) =>
        createAdmission((request, grant) => {
          if (request.stage === stage) {
            current = false;
          }
          admit(request, grant);
        }),
      );
    try {
      await expect(
        store.writeSession(
          { ...session, title: "Retired update" },
          {
            assertCurrent: () => {
              if (!current) {
                throw failure;
              }
            },
          },
        ),
      ).rejects.toBe(failure);
    } finally {
      observer.mockRestore();
    }
    expect(await store.readSession(session.sessionId)).toEqual(session);
  },
);

it("publishes captured summary notes without caller-thread transcript SQL", async () => {
  const { env, store } = fixture();
  const session: TranscriptSessionDescriptor = {
    sessionId: "summary-worker",
    startedAt: "2026-09-20T12:00:00.000Z",
    source: { providerId: "manual-transcript" },
  };
  await store.writeSession(session);
  await store.appendUtteranceForSession(session, { text: "We agreed to simplify setup." });
  await closeOpenClawStateDatabaseAsync();
  closeOpenClawStateDatabaseForTest();
  await withoutParentTranscriptSql(resolveOpenClawStateSqlitePath(env), async () => {
    const result = await persistTranscriptSummary({
      config: resolveTranscriptsConfig(undefined),
      store,
      session,
    });
    expect(result.summary.transcript).toEqual(["We agreed to simplify setup."]);
  });
  expect(await store.readSummary(session)).toMatchObject({
    summary: { transcript: ["We agreed to simplify setup."], utteranceCount: 1 },
    markdown: expect.stringContaining("We agreed to simplify setup."),
  });
});

it.each(["transaction", "commit"] as const)(
  "retains prior notes when the summary owner is revoked at the worker %s grant",
  async (stage) => {
    const { store } = fixture();
    const session: TranscriptSessionDescriptor = {
      sessionId: `summary-revoked-${stage}`,
      startedAt: "2026-09-20T12:00:00.000Z",
      source: { providerId: "manual-transcript" },
    };
    await store.writeSession(session);
    await store.appendUtteranceForSession(session, { text: "Fresh captured speech" });
    await store.writeSummary(
      summarizeTranscripts({ session, utterances: [{ text: "Retained earlier notes" }] }),
      session,
    );
    const previous = await store.readSummary(session);
    const failure = new TranscriptsSummaryChangedError();
    let current = true;
    const requests: workerAdmission.SqliteWorkerAdmissionRequest["stage"][] = [];
    const createAdmission = workerAdmission.createSqliteWorkerOperationAdmission;
    const observer = vi
      .spyOn(workerAdmission, "createSqliteWorkerOperationAdmission")
      .mockImplementation((admit) =>
        createAdmission((request, grant) => {
          requests.push(request.stage);
          if (request.stage === stage) {
            current = false;
          }
          admit(request, grant);
        }),
      );
    try {
      await expect(
        persistTranscriptSummary({
          config: resolveTranscriptsConfig(undefined),
          store,
          session,
          assertCurrent: () => {
            if (!current) {
              throw failure;
            }
          },
        }),
      ).rejects.toBe(failure);
    } finally {
      observer.mockRestore();
    }
    expect(requests).toContain(stage);
    expect(await store.readSummary(session)).toEqual(previous);
  },
);

it("reads populated transcripts after existing-only status and through reopen without parent SQL", async () => {
  const { env, store } = fixture();
  const databasePath = resolveOpenClawStateSqlitePath(env);
  const readStatus = () =>
    runOpenClawStateWorkerOperation(
      captureOpenClawStateWorkerContext({ env }),
      (scope) =>
        scope.execute({
          type: "tasks.statusSummary",
          input: { now: Date.now(), preserveSourceArtifacts: false },
        }),
      { existingOnly: true },
    );
  await withoutParentSql(async () => {
    expect(await readStatus()).toBeUndefined();
  });
  expect(existsSync(databasePath)).toBe(false);

  const session: TranscriptSessionDescriptor = {
    sessionId: "retained-meeting",
    title: "Retained meeting",
    startedAt: "2026-09-13T10:00:00.000Z",
    stoppedAt: "2026-09-13T10:05:00.000Z",
    source: { providerId: "manual-transcript", accountId: "synthetic" },
    metadata: { agentId: "main", sessionIdOrigin: "generated" },
  };
  const utterance: TranscriptUtterance = {
    id: "line-1",
    text: "Agenda approved.",
    speaker: { id: "speaker-1", label: "Sam" },
    final: true,
    metadata: { language: "en" },
  };
  const summary = summarizeTranscripts({ session, utterances: [utterance] });
  await store.writeSession(session);
  await store.appendUtteranceForSession(session, utterance);
  await store.writeSummary(summary, session);
  await closeOpenClawStateDatabaseAsync();
  closeOpenClawStateDatabaseForTest();

  const selector = transcriptSessionSelector(session);
  const started = performance.now();
  await withoutParentSql(async () => {
    expect((await readStatus())?.state).toBe("ready");
    expect(await store.readSession(selector)).toEqual(session);
    expect(await store.listSessionEntries()).toMatchObject([
      { session, selector, hasSummary: true },
    ]);
    expect((await store.matchSessionEntries(session.sessionId)).unqualified).toMatchObject([
      { session, selector, hasSummary: true },
    ]);
    expect(await store.readUtterancesForSession(session)).toEqual([
      { ...utterance, sessionId: session.sessionId },
    ]);
    expect((await store.readSummary(session)).summary).toEqual(summary);
    const { transcript: _transcript, ...notes } = summary;
    expect((await store.readNotes(session)).summary).toEqual(notes);
    expect(await store.readLatestEntry()).toMatchObject({ session, selector, utteranceCount: 1 });
    expect(await store.readEntry(selector)).toMatchObject({ session, selector, utteranceCount: 1 });
    const revision = await store.readSummaryInputRevision(session);
    expect(revision).toBeTypeOf("string");
    expect(
      await store.readRecentStoppedSession(
        session.source,
        "2026-09-13T10:04:00.000Z",
        "2026-09-13T10:06:00.000Z",
      ),
    ).toEqual({ session, inputRevision: revision });
    const page = await getTranscriptLibrary(store, { selector, includeUtterances: true, limit: 2 });
    expect(page.utterances).toMatchObject([
      { sequence: 0, text: "Agenda approved.", speakerLabel: "Sam" },
    ]);
    expect(page.nextCursor).toBeNull();
  });
  const coldReadMs = performance.now() - started;
  await closeOpenClawStateDatabaseAsync();
  closeOpenClawStateDatabaseForTest();
  const reopened = performance.now();
  await withoutParentSql(async () => {
    expect(await store.readSession(selector)).toEqual(session);
    expect((await store.readSummary(session)).summary).toEqual(summary);
    expect(await store.readUtterancesForSession(session)).toEqual([
      { ...utterance, sessionId: session.sessionId },
    ]);
  });
  console.info("populated transcript worker read timings", {
    coldReadMs,
    reopenReadMs: performance.now() - reopened,
  });
});

it("returns complete stored reads and typed library errors through close and reopen", async () => {
  const { env, store } = fixture();
  const session: TranscriptSessionDescriptor = {
    sessionId: "worker-meeting",
    source: { providerId: "manual-transcript", accountId: "synthetic" },
    title: "Worker meeting",
    startedAt: "2026-09-12T10:00:00.000Z",
    stoppedAt: "2026-09-12T11:00:00.000Z",
    metadata: { agentId: "main", sessionIdOrigin: "generated", nested: { values: [1, null] } },
  };
  const utterances: TranscriptUtterance[] = Array.from({ length: 20 }, (_, index) => ({
    id: `utterance-${index}`,
    text: `Meeting text ${index} 🦞\n`,
    speaker: { id: "speaker", label: "Speaker" },
    final: true,
    metadata: { index },
  }));
  await store.writeSession(session);
  for (const utterance of utterances) {
    await store.appendUtteranceForSession(session, utterance);
  }
  const summary = summarizeTranscripts({ session, utterances });
  await store.writeSummary(summary, session);
  await closeOpenClawStateDatabaseAsync();
  closeOpenClawStateDatabaseForTest();

  const selector = transcriptSessionSelector(session);
  const coldStarted = performance.now();
  await withoutParentSql(async () => {
    expect(await store.readSession(selector)).toEqual(session);
    expect(await store.listSessionEntries()).toMatchObject([
      { session, selector, hasSummary: true },
    ]);
    const matches = await store.matchSessionEntries(session.sessionId);
    expect(matches.qualified).toEqual([]);
    expect(matches.unqualified).toMatchObject([{ session, selector, hasSummary: true }]);
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
      utterances.map((utterance) => Object.assign({}, utterance, { sessionId: session.sessionId })),
    );
    expect(await store.readUtterancesForSession(session, { maxUtterances: 3 })).toEqual(
      utterances
        .slice(-3)
        .map((utterance) => Object.assign({}, utterance, { sessionId: session.sessionId })),
    );
    expect((await store.readSummary(session)).summary).toEqual(summary);
    const { transcript: _transcript, ...notes } = summary;
    const withHostOnlyMetadata = { ...session, metadata: { callback: () => undefined } };
    expect((await store.readNotes(withHostOnlyMetadata)).summary).toEqual(notes);
    expect(await store.readEntry(selector)).toMatchObject({
      session,
      selector,
      utteranceCount: 20,
    });
    expect(await store.readLatestEntry()).toMatchObject({ session, selector, utteranceCount: 20 });
    const page = await getTranscriptLibrary(store, { selector, includeUtterances: true, limit: 2 });
    expect(page.utterances?.map(({ sequence, text }) => ({ sequence, text }))).toEqual([
      { sequence: 0, text: "Meeting text 0 🦞\\n" },
      { sequence: 1, text: "Meeting text 1 🦞\\n" },
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
  const coldReadMs = performance.now() - coldStarted;
  await closeOpenClawStateDatabaseAsync();
  closeOpenClawStateDatabaseForTest();
  const reopenStarted = performance.now();
  await withoutParentSql(async () => {
    expect((await store.readSummary(session)).summary).toEqual(summary);
    expect(await store.readSession(selector)).toEqual(session);
  });
  const reopenReadMs = performance.now() - reopenStarted;
  await store.writeSession({ ...session, title: "x".repeat(TRANSCRIPTS_RESULT_MAX_BYTES + 1) });
  await withoutParentSql(async () => {
    const result = store.readEntry(selector);
    await expect(result).rejects.toBeInstanceOf(TranscriptLibraryError);
    await expect(result).rejects.toMatchObject({
      type: "transcript_result_too_large",
      maxBytes: TRANSCRIPTS_RESULT_MAX_BYTES,
    });
  });
  console.info("transcript worker read timings", {
    coldReadMs,
    reopenReadMs,
  });
});
