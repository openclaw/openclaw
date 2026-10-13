import { channel } from "node:diagnostics_channel";
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { createTempDirTracker } from "../../../test/helpers/temp-dir.js";
import * as logging from "../../logging/logger.js";
import { runExclusiveSessionLifecycleMutation } from "../../sessions/session-lifecycle-admission.js";
import {
  closeOpenClawAgentDatabaseByPathAsync,
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
  resolveIncognitoOpenClawAgentSqlitePath,
} from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseAsync } from "../../state/openclaw-state-db.js";
import {
  cleanupSessionLifecycleArtifactsCore,
  deleteSessionEntryLifecycle,
  loadSessionEntry,
  loadTranscriptEvents,
  replaceSessionEntry,
  replaceSessionEntrySync,
} from "./session-accessor.js";
import { readArtifactPreparationLogs } from "./session-accessor.sqlite-diagnostics.test-support.js";
import type { SqliteLifecycleTargetSnapshot } from "./session-accessor.sqlite-entry-equality.js";
import type {
  SqliteSessionReclamationPlan,
  SqliteSessionReclamationResult,
} from "./session-accessor.sqlite-lifecycle-types.js";
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
const tempDirs = createTempDirTracker();

describe("SQLite lifecycle cleanup reclamation", () => {
  let storePath: string;
  beforeEach(() => {
    storePath = path.join(
      tempDirs.make("openclaw-session-cleanup-reclamation-"),
      "agents",
      "main",
      "sessions",
      "sessions.json",
    );
  });
  afterEach(async () => {
    hook.after = undefined;
    await closeOpenClawAgentDatabasesAsync();
    await closeOpenClawStateDatabaseAsync();
    await logging.flushLogger();
    logging.resetLogger();
    closeOpenClawAgentDatabasesForTest();
    vi.restoreAllMocks();
    tempDirs.cleanup();
    vi.unstubAllEnvs();
  });
  const scope = (sessionId: string) => ({
    sessionId,
    sessionKey: `agent:main:${sessionId}`,
    storePath,
  });
  function database() {
    const target = resolveSqliteTargetFromSessionStorePath(storePath, { agentId: "main" });
    if (!target.path) {
      throw new Error("expected reclamation database path");
    }
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

  it.each(["replace", "delete"] as const)(
    "rejects a stale entry plan before mutation after an awaited %s",
    async (mutation) => {
      const current = scope("queued-entry-deletion");
      const entry = { sessionId: current.sessionId, updatedAt: Date.now() };
      await replaceSessionEntry(current, entry);
      await closeOpenClawAgentDatabaseByPathAsync(database().path);
      const databasePath = database().path;
      const target = { canonicalKey: current.sessionKey, storeKeys: [current.sessionKey] };
      const entered = createDeferred();
      const prepared = createDeferred();
      let preparedTargetSnapshot: SqliteLifecycleTargetSnapshot | undefined;
      const prepare = reclamation.runSessionDeletionPlanning;
      vi.spyOn(reclamation, "runSessionDeletionPlanning").mockImplementationOnce(
        async (...args) => {
          const result = await prepare(...args);
          if (result.operation !== "entry" || result.value.kind !== "ready") {
            throw new Error("Expected the original entry to finish deletion planning");
          }
          preparedTargetSnapshot = result.value.value.targetSnapshot;
          expect(preparedTargetSnapshot).toMatchObject([{ sessionKey: current.sessionKey, entry }]);
          prepared.resolve();
          return result;
        },
      );
      const entryReclamations: Array<{
        plan: Extract<SqliteSessionReclamationPlan, { kind: "entry" }>;
        result: SqliteSessionReclamationResult;
      }> = [];
      const reclaim = reclamation.runSqliteSessionReclamation;
      vi.spyOn(reclamation, "runSqliteSessionReclamation").mockImplementation(async (params) => {
        const result = await reclaim(params);
        if (params.plan.kind === "entry") {
          entryReclamations.push({ plan: params.plan, result });
        }
        return result;
      });
      const previous = runExclusiveSessionLifecycleMutation("delete", {
        scope: storePath,
        identities: [current.sessionKey, current.sessionId],
        run: async () => {
          entered.resolve();
          await prepared.promise;
          if (mutation === "replace") {
            await replaceSessionEntry(current, {
              ...entry,
              label: "changed by the preceding owner",
            });
          } else {
            expect(
              (await deleteSessionEntryLifecycle({ archiveTranscript: false, storePath, target }))
                .deleted,
            ).toBe(true);
          }
        },
      });
      let deletion: ReturnType<typeof deleteSessionEntryLifecycle> | undefined;
      try {
        await entered.promise;
        deletion = deleteSessionEntryLifecycle({
          archiveTranscript: false,
          storePath,
          target,
        });
        // Preparation observes the old row while the preceding lifecycle owner is held.
        await Promise.race([
          previous,
          deletion.then(() => {
            throw new Error("Deletion completed without waiting for the preceding lifecycle owner");
          }),
        ]);
        await expect(deletion).resolves.toEqual({
          archivedTranscripts: [],
          deleted: false,
          expectedEntryMismatch: true,
        });
        expect(preparedTargetSnapshot).toBeDefined();
        expect(entryReclamations).toHaveLength(mutation === "delete" ? 2 : 1);
        for (const { plan } of entryReclamations) {
          expect(plan).toMatchObject({
            kind: "entry",
            databaseOptions: { path: databasePath },
            deleteParams: { target },
          });
          expect(plan.preparedTargetSnapshot).toEqual(preparedTargetSnapshot);
        }
        expect(entryReclamations.at(-1)?.result).toEqual({
          kind: "entry",
          value: { archivedTranscripts: [], deleted: false, expectedEntryMismatch: true },
        });
        if (mutation === "delete") {
          expect(entryReclamations[0]?.result).toMatchObject({
            kind: "entry",
            value: { deleted: true, deletedSessionId: current.sessionId },
          });
        }
        if (mutation === "replace") {
          expect(loadSessionEntry(current)).toMatchObject({
            ...entry,
            label: "changed by the preceding owner",
          });
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
    if (!expectedEntry) {
      throw new Error("expected guarded entry");
    }
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
    expect(result).toMatchObject({ deleted: false, expectedEntryMismatch: true });
    expect(materializations).toBe(2);
    expect(result.archivedTranscripts).toEqual([
      expect.objectContaining({ sessionId: history.sessionId }),
    ]);
    await expect(loadTranscriptEvents(history)).resolves.toEqual([]);
    expect(loadSessionEntry(current)).toEqual(replacement);
    await expect(loadTranscriptEvents(current)).resolves.toEqual(events);
  });

  it.each([false, true])(
    "preserves native incognito marker phases and late read failure=%s",
    async (fail) => {
      vi.stubEnv("OPENCLAW_STATE_DIR", tempDirs.make("incognito-cleanup-"));
      storePath = resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main" });
      const history = scope("marker-scan-history");
      const events = [
        { type: "metadata", runId: fail ? "cleanup-race-marker" : "ordinary-row" },
        { type: "metadata", runId: "failing-tail" },
      ];
      await replaceSessionEntry(history, { sessionId: history.sessionId, updatedAt: 1 });
      await replaceTranscriptEvents(history, events);
      await replaceSessionEntry(history, {
        sessionId: "marker-scan-current",
        updatedAt: Date.now(),
        skillsSnapshot: { prompt: "unrelated saved prompt".repeat(1024), skills: [] },
      });
      const before = structuredClone(loadSessionEntry(history));
      await closeOpenClawStateDatabaseAsync();
      const db = database();
      const failure = new Error("late native transcript read failure");
      const observed: unknown[] = [];
      let snapshotReads = 0;
      db.db.function("cleanup_snapshot_value", (valueJson) => {
        snapshotReads += 1;
        return valueJson;
      });
      db.db.exec(`CREATE TEMP VIEW session_entry_snapshots AS
        SELECT session_key, field, cleanup_snapshot_value(value_json) AS value_json
        FROM main.session_entry_snapshots`);
      let clock = 0;
      let advanceClock = true;
      vi.spyOn(performance, "now").mockImplementation(() => clock);
      db.db.function("cleanup_marker_event", (eventJson) => {
        observed.push(eventJson);
        if (advanceClock) {
          clock += 600;
        }
        if (fail && eventJson === JSON.stringify(events[1])) {
          throw failure;
        }
        return eventJson;
      });
      db.db.function("cleanup_event_age", (createdAt) => {
        if (advanceClock) {
          clock += 20;
        }
        return createdAt;
      });
      // Native age/payload reads advance the clock, independently of timer call counts.
      db.db.exec(`CREATE TEMP VIEW transcript_events AS
        SELECT session_id, seq, cleanup_marker_event(event_json) AS event_json,
          event_zstd, event_utf8_bytes, navigation_json, cleanup_event_age(created_at) AS created_at
        FROM main.transcript_events`);
      const logPath = path.join(tempDirs.make("cleanup-diagnostics-log-"), "writer.log");
      vi.stubEnv("OPENCLAW_TEST_FILE_LOG", "1");
      logging.setLoggerOverride({ level: "warn", file: logPath });
      const run = () =>
        cleanup(Date.now(), {
          archiveRemovedEntryTranscripts: false,
          sessionKeySegmentPrefix: "unrelated-prefix-",
          transcriptContentMarker: "cleanup-race-marker",
          orphanTranscriptMinAgeMs: 0,
        });
      const empty = { removedEntries: 0, archivedTranscriptArtifacts: 0 };
      let workersStarted = 0;
      const onWorker = () => {
        workersStarted += 1;
      };
      channel("worker_threads").subscribe(onWorker);
      try {
        if (fail) {
          await expect(run()).rejects.toBe(failure);
        } else {
          await expect(run()).resolves.toEqual(empty);
        }
        expect(workersStarted).toBe(0);
        expect(snapshotReads).toBe(0);
        const records = await readArtifactPreparationLogs(logPath);
        expect(records).toHaveLength(1);
        expect(records[0]?.message).toBe(
          fail ? "SQLite session write failed" : "slow SQLite session write",
        );
        expect(records[0]?.details.artifactPreparation).toEqual({
          admissionMode: "cached",
          admissionMs: 0,
          nodeInventoryMs: 0,
          referencePlanningMs: 0,
          orphanPlanningMs: 40,
          markerScanMs: 1200,
          nodeRows: 1,
          windowRows: 1,
          referenceIds: 1,
          selectedEntries: 0,
          markerWindows: 1,
          markerRows: fail ? 1 : 2,
          ...(fail ? {} : { deletePlans: 0 }),
          completed: !fail,
        });
        expect(observed).toEqual(events.map((event) => JSON.stringify(event)));
        if (!fail) {
          advanceClock = false;
          await expect(run()).resolves.toEqual(empty);
          expect(await readArtifactPreparationLogs(logPath)).toEqual(records);
          expect(snapshotReads).toBe(0);
        }
      } finally {
        channel("worker_threads").unsubscribe(onWorker);
        db.db.exec("DROP VIEW temp.transcript_events");
        db.db.exec("DROP VIEW temp.session_entry_snapshots");
      }
      expect(workersStarted).toBe(0);
      expect(loadSessionEntry(history)).toEqual(before);
      await expect(loadTranscriptEvents(history)).resolves.toEqual(events);
    },
  );

  it("reclaims cold orphan-only history and republishes pending archives on a cold empty pass", async () => {
    const now = Date.now();
    const history = { ...scope("orphaned-history"), sessionKey: "agent:main:current" };
    await replaceSessionEntry(history, { sessionId: history.sessionId, updatedAt: now - 600_000 });
    await replaceTranscriptEvents(history, [
      {
        type: "metadata",
        runId: "cleanup-reclamation-marker-orphan",
        timestamp: new Date(now - 600_000).toISOString(),
      },
    ]);
    const current = { sessionId: "current-session", updatedAt: now };
    await replaceSessionEntry(history, current);
    await closeDatabases();
    await expect(cleanup(now)).resolves.toEqual({
      removedEntries: 0,
      archivedTranscriptArtifacts: 1,
    });
    expect(loadSessionEntry(history)).toMatchObject(current);
    await expect(loadTranscriptEvents(history)).resolves.toEqual([]);
    const db = database();
    const archive = db.db
      .prepare("SELECT archive_name FROM session_transcript_archives WHERE session_id = ?")
      .get(history.sessionId);
    if (typeof archive?.archive_name !== "string") {
      throw new Error("expected published orphan archive");
    }
    const archivePath = path.join(path.dirname(storePath), archive.archive_name);
    const bytes = fs.readFileSync(archivePath);
    fs.rmSync(archivePath);
    db.db
      .prepare("UPDATE session_transcript_archives SET published_at = NULL WHERE session_id = ?")
      .run(history.sessionId);
    await closeDatabases();
    await expect(cleanup(now)).resolves.toEqual({
      removedEntries: 0,
      archivedTranscriptArtifacts: 0,
    });
    expect(fs.readFileSync(archivePath)).toEqual(bytes);
    expect(
      database()
        .db.prepare("SELECT published_at FROM session_transcript_archives WHERE session_id = ?")
        .get(history.sessionId),
    ).toEqual({ published_at: expect.any(Number) });
    expect(loadSessionEntry(history)).toMatchObject(current);
  });

  it("keeps the event loop responsive while committing a large transcript", async () => {
    const rows = 100_000;
    const now = Date.now();
    const current = scope("cleanup-reclamation-large");
    const unrelated = scope("cleanup-reclamation-unrelated");
    const event = {
      type: "metadata",
      runId: "cleanup-reclamation-marker",
      timestamp: new Date(now - 600_000).toISOString(),
    };
    await replaceSessionEntry(current, { sessionId: current.sessionId, updatedAt: now - 600_000 });
    await replaceSessionEntry(unrelated, { sessionId: unrelated.sessionId, updatedAt: now });
    await replaceTranscriptEvents(current, [event]);
    const db = database();
    const insert = db.db.prepare(
      "INSERT INTO transcript_events (session_id, seq, event_json, created_at) VALUES (?, ?, ?, ?)",
    );
    const last = db.db
      .prepare("SELECT max(seq) AS seq FROM transcript_events WHERE session_id = ?")
      .get(current.sessionId)?.seq;
    if (typeof last !== "number" && typeof last !== "bigint") {
      throw new Error("expected transcript sequence");
    }
    const initialSeq = Number(last);
    const eventJson = JSON.stringify(event);
    // sqlite-allow-raw -- bulk fixture setup stays outside the measured cleanup commit.
    db.db.exec("BEGIN IMMEDIATE");
    try {
      for (let index = 1; index < rows; index += 1) {
        insert.run(current.sessionId, initialSeq + index, eventJson, now - 600_000 + index);
      }
      insert.run(
        unrelated.sessionId,
        0,
        JSON.stringify({ type: "metadata", runId: "unrelated" }),
        now,
      );
      // sqlite-allow-raw -- commits the deterministic fixture before measurement.
      db.db.exec("COMMIT");
    } catch (error) {
      // sqlite-allow-raw -- releases the failed fixture transaction.
      db.db.exec("ROLLBACK");
      throw error;
    }
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
    let result: Awaited<ReturnType<typeof cleanupSessionLifecycleArtifactsCore>>;
    try {
      result = await cleanup(now, { sessionKeySegmentPrefix: "cleanup-reclamation-large" });
    } finally {
      if (heartbeat) {
        clearInterval(heartbeat);
      }
    }
    const maxGapMs = Math.max(...samples);
    if (process.env.OPENCLAW_TEST_RECLAMATION_LOG === "1") {
      process.stdout.write(
        `${JSON.stringify({ owner: "lifecycle-cleanup", rows, maxGapMs, result })}\n`,
      );
    }
    expect(result).toEqual({ removedEntries: 1, archivedTranscriptArtifacts: 1 });
    expect(samples.length).toBeGreaterThan(0);
    expect(maxGapMs).toBeLessThan(500);
    expect(loadSessionEntry(current)).toBeUndefined();
    expect(loadSessionEntry(unrelated)).toMatchObject({ sessionId: unrelated.sessionId });
    expect(
      db.db
        .prepare("SELECT count(*) AS count FROM transcript_events WHERE session_id = ?")
        .get(current.sessionId),
    ).toEqual({ count: 0 });
    expect(
      db.db
        .prepare(
          "SELECT archive_sha256, published_at FROM session_transcript_archives WHERE session_id = ?",
        )
        .get(current.sessionId),
    ).toMatchObject({
      archive_sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      published_at: expect.any(Number),
    });
  }, 120_000);
});
