import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import { runSqliteImmediateTransactionSync } from "../../infra/sqlite-transaction.js";
import { runSessionMutation } from "../../sessions/session-controller.lifecycle.js";
import {
  closeOpenClawAgentDatabaseByPathAsync,
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { requireNativeSqliteDatabase } from "../../test-utils/native-sqlite.js";
import { useSessionStoreTempDirs } from "../../test-utils/session-state-cleanup.js";
import {
  cleanupSessionLifecycleArtifactsCore,
  deleteSessionEntryLifecycle,
  loadSessionEntry,
  loadTranscriptEvents,
  replaceSessionEntry,
  replaceSessionEntrySync,
} from "./session-accessor.js";
import * as reclamation from "./session-accessor.sqlite-reclamation-run.js";
import { replaceTranscriptEvents } from "./session-accessor.sqlite-transcript-write.test-support.js";
import { resolveSqliteTargetFromSessionStorePath } from "./session-sqlite-target.js";

const hook = vi.hoisted(() => ({ after: undefined as (() => void) | undefined }));
vi.mock("./session-accessor.sqlite-archive.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./session-accessor.sqlite-archive.js")>();
  return {
    ...actual,
    materializeSessionStateDeletePlans: async (
      ...args: Parameters<typeof actual.materializeSessionStateDeletePlans>
    ) => {
      const result = await actual.materializeSessionStateDeletePlans(...args);
      hook.after?.();
      return result;
    },
  };
});
const staleEntry = { deleted: false, expectedEntryMismatch: true };
function metadata(now: number, runId = "cleanup-reclamation-marker") {
  return { type: "metadata", runId, timestamp: new Date(now - 600_000).toISOString() };
}

let storePath: string;
beforeEach(() => {
  storePath = path.join(tempDirs.make(), "agents/main/sessions/sessions.json");
});
afterEach(() => {
  hook.after = undefined;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
const tempDirs = useSessionStoreTempDirs(afterEach, "openclaw-session-cleanup-reclamation-");
function scope(sessionId: string) {
  return { sessionId, sessionKey: `agent:main:${sessionId}`, storePath };
}
function database() {
  const target = resolveSqliteTargetFromSessionStorePath(storePath, { agentId: "main" });
  assert.ok(target.path, "expected reclamation database path");
  return openOpenClawAgentDatabase({ agentId: "main", path: target.path });
}
const cleanup = (
  nowMs: number,
  options: Partial<Parameters<typeof cleanupSessionLifecycleArtifactsCore>[0]> = {},
) =>
  cleanupSessionLifecycleArtifactsCore({
    storePath,
    sessionKeySegmentPrefix: "cleanup-reclamation-",
    transcriptContentMarker: "cleanup-reclamation-marker",
    orphanTranscriptMinAgeMs: 300_000,
    nowMs,
    ...options,
  });
async function closeDatabases() {
  await closeOpenClawAgentDatabasesAsync();
  closeOpenClawAgentDatabasesForTest();
}
const archive = (sessionId: string) =>
  database()
    .db.prepare("SELECT * FROM session_transcript_archives WHERE session_id = ?")
    .get(sessionId);

it.each(["replace", "delete"] as const)(
  "rejects a stale entry plan before mutation after an awaited %s",
  async (mutation) => {
    const current = scope("queued-entry-deletion");
    const entry = { sessionId: current.sessionId, updatedAt: Date.now() };
    const replacement = { ...entry, label: "changed by the preceding owner" };
    await replaceSessionEntry(current, entry);
    await closeOpenClawAgentDatabaseByPathAsync(database().path);
    const deletionParams = {
      archiveTranscript: false,
      storePath,
      target: { canonicalKey: current.sessionKey, storeKeys: [current.sessionKey] },
    };
    const entered = createDeferred();
    const prepared = createDeferred();
    const prepare = reclamation.runSessionDeletionPlanning;
    vi.spyOn(reclamation, "runSessionDeletionPlanning").mockImplementationOnce(async (...args) => {
      const result = await prepare(...args);
      prepared.resolve();
      return result;
    });
    const previous = runSessionMutation({
      scope: storePath,
      identities: [current.sessionKey, current.sessionId],
      run: async () => {
        entered.resolve();
        await prepared.promise;
        if (mutation === "replace") {
          await replaceSessionEntry(current, replacement);
        } else {
          expect((await deleteSessionEntryLifecycle(deletionParams)).deleted).toBe(true);
        }
      },
    });
    let deletion: ReturnType<typeof deleteSessionEntryLifecycle> | undefined;
    try {
      await entered.promise;
      deletion = deleteSessionEntryLifecycle(deletionParams);
      // Preparation observes the old row while the preceding lifecycle owner is held.
      await awaitGateBeforeSettlement(
        previous,
        deletion,
        "Deletion completed without waiting for the preceding lifecycle owner",
      );
      await expect(deletion).resolves.toEqual({ ...staleEntry, archivedTranscripts: [] });
      if (mutation === "replace") {
        expect(loadSessionEntry(current)).toMatchObject(replacement);
      } else {
        expect(loadSessionEntry(current)).toBeUndefined();
      }
    } finally {
      prepared.resolve();
      await Promise.allSettled([previous, ...(deletion ? [deletion] : [])]);
    }
  },
);

it("keeps published history when the entry changes during final materialization", async () => {
  const current = scope("entry-materialization-run");
  const history = { ...current, sessionId: "entry-materialization-history" };
  const updatedAt = Date.now();
  const events = [{ type: "session", id: current.sessionId, content: "original transcript" }];
  await replaceSessionEntry(history, { sessionId: history.sessionId, updatedAt });
  await replaceTranscriptEvents(history, [
    { type: "session", id: history.sessionId, content: "already published history" },
  ]);
  await replaceSessionEntry(current, { sessionId: current.sessionId, updatedAt });
  await replaceTranscriptEvents(current, events);
  const expectedEntry = loadSessionEntry(current);
  assert.ok(expectedEntry, "expected guarded entry");
  const replacement = { ...expectedEntry, label: "concurrent replacement" };
  let materializations = 0;
  hook.after = () => {
    if (++materializations === 2) {
      replaceSessionEntrySync(current, replacement);
    }
  };
  const result = await deleteSessionEntryLifecycle({
    archiveTranscript: true,
    expectedEntry,
    storePath,
    target: { canonicalKey: current.sessionKey, storeKeys: [current.sessionKey] },
  });
  expect(result).toMatchObject({
    ...staleEntry,
    archivedTranscripts: [expect.objectContaining({ sessionId: history.sessionId })],
  });
  expect(materializations).toBe(2);
  await expect(loadTranscriptEvents(history)).resolves.toEqual([]);
  expect(loadSessionEntry(current)).toEqual(replacement);
  await expect(loadTranscriptEvents(current)).resolves.toEqual(events);
});

it("reclaims cold orphan-only history and republishes pending archives on a cold empty pass", async () => {
  const now = Date.now();
  const history = { ...scope("orphaned-history"), sessionKey: "agent:main:current" };
  await replaceSessionEntry(history, { sessionId: history.sessionId, updatedAt: now - 600_000 });
  await replaceTranscriptEvents(history, [metadata(now, "cleanup-reclamation-marker-orphan")]);
  const current = { sessionId: "current-session", updatedAt: now };
  await replaceSessionEntry(history, current);
  await closeDatabases();
  const reclaimed = await cleanup(now);
  expect(reclaimed).toEqual({ removedEntries: 0, archivedTranscriptArtifacts: 1 });
  expect(loadSessionEntry(history)).toMatchObject(current);
  await expect(loadTranscriptEvents(history)).resolves.toEqual([]);
  const db = database();
  const archiveName = archive(history.sessionId)?.archive_name;
  assert.ok(typeof archiveName === "string", "expected published orphan archive");
  const archivePath = path.join(path.dirname(storePath), archiveName);
  const bytes = fs.readFileSync(archivePath);
  fs.rmSync(archivePath);
  db.db
    .prepare("UPDATE session_transcript_archives SET published_at = NULL WHERE session_id = ?")
    .run(history.sessionId);
  await closeDatabases();
  const empty = await cleanup(now);
  expect(empty).toEqual({ removedEntries: 0, archivedTranscriptArtifacts: 0 });
  expect(fs.readFileSync(archivePath)).toEqual(bytes);
  expect(archive(history.sessionId)).toMatchObject({ published_at: expect.any(Number) });
  expect(loadSessionEntry(history)).toMatchObject(current);
});

it("keeps the event loop responsive while committing a large transcript", async () => {
  const rows = 100_000;
  const now = Date.now();
  const current = scope("cleanup-reclamation-large");
  const unrelated = scope("cleanup-reclamation-unrelated");
  const event = metadata(now);
  await replaceSessionEntry(current, { sessionId: current.sessionId, updatedAt: now - 600_000 });
  await replaceSessionEntry(unrelated, { sessionId: unrelated.sessionId, updatedAt: now });
  await replaceTranscriptEvents(current, [event]);
  const db = database();
  const insert = db.db.prepare(
    "INSERT INTO transcript_events (session_id, seq, event_json, created_at) VALUES (?, ?, ?, ?)",
  );
  const eventJson = JSON.stringify(event);
  runSqliteImmediateTransactionSync(requireNativeSqliteDatabase(db.db), () => {
    // The one-event replacement seeds seq 0; append without allocating 100k fixture objects.
    for (let index = 1; index < rows; index += 1) {
      insert.run(current.sessionId, index, eventJson, now - 600_000 + index);
    }
    insert.run(unrelated.sessionId, 0, '{"type":"metadata","runId":"unrelated"}', now);
  });
  const samples: number[] = [];
  let previous = 0;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  hook.after = () => {
    previous = performance.now();
    heartbeat = setInterval(() => {
      const time = performance.now();
      samples.push(time - previous);
      previous = time;
    }, 10);
  };
  using heartbeatCleanup = { [Symbol.dispose]: () => clearInterval(heartbeat) };
  const result = await cleanup(now, { sessionKeySegmentPrefix: "cleanup-reclamation-large" });
  heartbeatCleanup[Symbol.dispose]();
  expect(result).toEqual({ removedEntries: 1, archivedTranscriptArtifacts: 1 });
  expect(samples.length).toBeGreaterThan(0);
  expect(Math.max(...samples)).toBeLessThan(500);
  expect(loadSessionEntry(current)).toBeUndefined();
  expect(loadSessionEntry(unrelated)).toMatchObject({ sessionId: unrelated.sessionId });
  expect(
    db.db
      .prepare("SELECT count(*) AS count FROM transcript_events WHERE session_id = ?")
      .get(current.sessionId),
  ).toEqual({ count: 0 });
  expect(archive(current.sessionId)).toMatchObject({
    archive_sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
    published_at: expect.any(Number),
  });
}, 120_000);
