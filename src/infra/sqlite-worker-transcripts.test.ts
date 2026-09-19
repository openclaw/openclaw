import { existsSync } from "node:fs";
import path from "node:path";
import { DatabaseSync, StatementSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { TRANSCRIPTS_RESULT_MAX_BYTES } from "../../packages/gateway-protocol/src/schema/transcripts.js";
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
import { getTranscriptLibrary } from "../transcripts/library.js";
import type {
  TranscriptSessionDescriptor,
  TranscriptUtterance,
} from "../transcripts/provider-types.js";
import { readTranscriptLibraryStatus } from "../transcripts/status.js";
import { TranscriptLibraryError } from "../transcripts/store-read.js";
import { TranscriptsStore, transcriptSessionSelector } from "../transcripts/store.js";
import { summarizeTranscripts } from "../transcripts/summary.js";

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

it("keeps cold transcript reads on the canonical worker and preserves store creation", async () => {
  const { env, exportRoot, store } = fixture();
  const databasePath = resolveOpenClawStateSqlitePath(env);
  expect(existsSync(databasePath)).toBe(false);
  await withoutParentSql(async () => {
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
