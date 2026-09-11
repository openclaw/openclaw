import { channel } from "node:diagnostics_channel";
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import * as logging from "../../logging/logger.js";
import { runExclusiveSessionLifecycleMutation } from "../../sessions/session-lifecycle-admission.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import {
  cleanupSessionLifecycleArtifactsCore,
  deleteSessionEntryLifecycle,
  loadSessionEntry,
  loadTranscriptEvents,
  replaceSessionEntry,
  replaceSessionEntrySync,
} from "./session-accessor.js";
import { readArtifactPreparationLogs } from "./session-accessor.sqlite-diagnostics.test-support.js";
import { replaceTranscriptEvents } from "./session-accessor.sqlite-transcript-write.js";
import { resolveSqliteTargetFromSessionStorePath } from "./session-sqlite-target.js";

const archiveMaterializationHook = vi.hoisted(() => ({
  afterMaterialize: undefined as (() => void) | undefined,
}));

vi.mock("./session-accessor.sqlite-archive.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./session-accessor.sqlite-archive.js")>();
  return {
    ...actual,
    materializeSessionStateDeletePlans: async (
      ...args: Parameters<typeof actual.materializeSessionStateDeletePlans>
    ) => {
      const result = await actual.materializeSessionStateDeletePlans(...args);
      archiveMaterializationHook.afterMaterialize?.();
      return result;
    },
  };
});

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

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
    archiveMaterializationHook.afterMaterialize = undefined;
    await logging.flushLogger();
    logging.resetLogger();
    closeOpenClawAgentDatabasesForTest();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("does not start a worker when startup cleanup has nothing to reclaim", async () => {
    const now = Date.now();
    const sessionKey = "agent:main:current";
    const entry = { sessionId: "current-session", updatedAt: now };
    await replaceSessionEntry({ sessionKey, storePath }, entry);

    let workersStarted = 0;
    const workerChannel = channel("worker_threads");
    const onWorker = () => {
      workersStarted += 1;
    };
    workerChannel.subscribe(onWorker);
    try {
      await expect(
        cleanupSessionLifecycleArtifactsCore({
          storePath,
          sessionKeySegmentPrefix: "cleanup-reclamation-",
          transcriptContentMarker: "cleanup-reclamation-marker",
          orphanTranscriptMinAgeMs: 300_000,
          nowMs: now,
        }),
      ).resolves.toEqual({ removedEntries: 0, archivedTranscriptArtifacts: 0 });
    } finally {
      workerChannel.unsubscribe(onWorker);
    }
    expect(workersStarted).toBe(0);
    expect(loadSessionEntry({ sessionKey, storePath })).toMatchObject(entry);
  });

  it.each(["replace", "delete"] as const)(
    "rejects a stale entry plan before starting a Worker after an awaited %s",
    async (mutation) => {
      const sessionKey = "agent:main:queued-entry-deletion";
      const sessionId = "queued-entry-deletion";
      const entry = { sessionId, updatedAt: Date.now() };
      await replaceSessionEntry({ sessionKey, storePath }, entry);
      const target = { canonicalKey: sessionKey, storeKeys: [sessionKey] };
      const entered = createDeferred();
      const prepared = createDeferred();
      let workersStarted = 0;
      let workersBeforeRelease = 0;
      const onWorker = () => {
        workersStarted += 1;
      };
      const workerChannel = channel("worker_threads");
      workerChannel.subscribe(onWorker);
      const previousMutation = runExclusiveSessionLifecycleMutation({
        scope: storePath,
        identities: [sessionKey, sessionId],
        run: async () => {
          entered.resolve();
          await prepared.promise;
          if (mutation === "replace") {
            await replaceSessionEntry(
              { sessionKey, storePath },
              { ...entry, label: "changed by the preceding owner" },
            );
          } else {
            const result = await deleteSessionEntryLifecycle({
              archiveTranscript: false,
              storePath,
              target,
            });
            expect(result.deleted).toBe(true);
          }
          workersBeforeRelease = workersStarted;
        },
      });
      let deletion: ReturnType<typeof deleteSessionEntryLifecycle> | undefined;
      try {
        await entered.promise;
        deletion = deleteSessionEntryLifecycle({
          archiveTranscript: false,
          commitGuard: () => prepared.resolve(),
          storePath,
          target,
        });
        // Preparation reads the old row while the prior lifecycle owner is held;
        // its queued mutation commits before this deletion acquires that hold.
        await previousMutation;
        await expect(deletion).resolves.toEqual({
          archivedTranscripts: [],
          deleted: false,
          expectedEntryMismatch: true,
        });
        expect(workersStarted).toBe(workersBeforeRelease);
        const current = loadSessionEntry({ sessionKey, storePath });
        if (mutation === "replace") {
          expect(current).toMatchObject({ ...entry, label: "changed by the preceding owner" });
        } else {
          expect(current).toBeUndefined();
        }
      } finally {
        prepared.resolve();
        await Promise.allSettled([previousMutation, ...(deletion ? [deletion] : [])]);
        workerChannel.unsubscribe(onWorker);
      }
    },
  );

  it("keeps published history when the entry changes during final materialization", async () => {
    const sessionKey = "agent:main:entry-materialization-race";
    const historicalSessionId = "entry-materialization-history";
    const sessionId = "entry-materialization-run";
    const events = [{ type: "session" as const, id: sessionId, content: "original transcript" }];
    await replaceSessionEntry(
      { sessionKey, storePath },
      { sessionId: historicalSessionId, updatedAt: 1 },
    );
    await replaceTranscriptEvents({ sessionKey, sessionId: historicalSessionId, storePath }, [
      { type: "session", id: historicalSessionId, content: "already published history" },
    ]);
    await replaceSessionEntry({ sessionKey, storePath }, { sessionId, updatedAt: 1 });
    await replaceTranscriptEvents({ sessionKey, sessionId, storePath }, events);
    const currentEntry = loadSessionEntry({ sessionKey, storePath });
    if (!currentEntry) {
      throw new Error("expected current guarded entry");
    }
    const replacementEntry = { ...currentEntry, label: "concurrent replacement" };
    let materializations = 0;
    archiveMaterializationHook.afterMaterialize = () => {
      if (++materializations === 2) {
        replaceSessionEntrySync({ sessionKey, storePath }, replacementEntry);
      }
    };

    const result = await deleteSessionEntryLifecycle({
      archiveTranscript: true,
      expectedEntry: currentEntry,
      expectedTranscript: { eventJson: [JSON.stringify(events[0])], sessionId },
      storePath,
      target: { canonicalKey: sessionKey, storeKeys: [sessionKey] },
    });

    expect(result).toMatchObject({
      deleted: false,
      expectedEntryMismatch: true,
    });
    expect(materializations).toBe(2);
    expect(result.archivedTranscripts).toEqual([
      expect.objectContaining({ sessionId: historicalSessionId }),
    ]);
    await expect(
      loadTranscriptEvents({ sessionKey, sessionId: historicalSessionId, storePath }),
    ).resolves.toEqual([]);
    expect(loadSessionEntry({ sessionKey, storePath })).toEqual(replacementEntry);
    await expect(loadTranscriptEvents({ sessionKey, sessionId, storePath })).resolves.toEqual(
      events,
    );
  });

  it.each([false, true])(
    "reports warm marker phases without changing native failure=%s",
    async (fail) => {
      const sessionKey = "agent:main:marker-scan-history";
      const sessionId = "marker-scan-history";
      const events = [
        { type: "metadata", runId: fail ? "cleanup-race-marker" : "ordinary-row" },
        { type: "metadata", runId: "failing-tail" },
      ];
      await replaceSessionEntry({ sessionKey, storePath }, { sessionId, updatedAt: 1 });
      await replaceTranscriptEvents({ sessionKey, sessionId, storePath }, events);
      await replaceSessionEntry(
        { sessionKey, storePath },
        { sessionId: "marker-scan-current", updatedAt: Date.now() },
      );
      const before = structuredClone(loadSessionEntry({ sessionKey, storePath }));
      const database = openDatabase(storePath);
      const failure = new Error("late native transcript read failure");
      const observed: unknown[] = [];
      let clock = 0;
      let advanceClock = true;
      vi.spyOn(performance, "now").mockImplementation(() => clock);
      database.db.function("cleanup_marker_event", (eventJson) => {
        observed.push(eventJson);
        if (advanceClock) {
          clock += 600;
        }
        if (fail && eventJson === JSON.stringify(events[1])) {
          throw failure;
        }
        return eventJson;
      });
      database.db.function("cleanup_event_age", (createdAt) => {
        if (advanceClock) {
          clock += 20;
        }
        return createdAt;
      });
      // Native age and payload reads advance the clock, not the number of timer calls.
      database.db.exec(`CREATE TEMP VIEW transcript_events AS
        SELECT session_id, seq, cleanup_marker_event(event_json) AS event_json,
          cleanup_event_age(created_at) AS created_at
        FROM main.transcript_events`);
      const logPath = path.join(tempDirs.make("cleanup-diagnostics-log-"), "writer.log");
      vi.stubEnv("OPENCLAW_TEST_FILE_LOG", "1");
      logging.setLoggerOverride({ level: "warn", file: logPath });
      const cleanup = () =>
        cleanupSessionLifecycleArtifactsCore({
          storePath,
          archiveRemovedEntryTranscripts: false,
          sessionKeySegmentPrefix: "unrelated-prefix-",
          transcriptContentMarker: "cleanup-race-marker",
          orphanTranscriptMinAgeMs: 0,
          nowMs: Date.now(),
        });
      let workersStarted = 0;
      const onWorker = () => {
        workersStarted += 1;
      };
      channel("worker_threads").subscribe(onWorker);
      try {
        if (fail) {
          await expect(cleanup()).rejects.toBe(failure);
        } else {
          await expect(cleanup()).resolves.toEqual({
            removedEntries: 0,
            archivedTranscriptArtifacts: 0,
          });
        }
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
          windowRows: 2,
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
          await expect(cleanup()).resolves.toEqual({
            removedEntries: 0,
            archivedTranscriptArtifacts: 0,
          });
          expect(await readArtifactPreparationLogs(logPath)).toEqual(records);
        }
      } finally {
        channel("worker_threads").unsubscribe(onWorker);
        database.db.exec("DROP VIEW temp.transcript_events");
      }
      expect(workersStarted).toBe(0);
      expect(loadSessionEntry({ sessionKey, storePath })).toEqual(before);
      await expect(loadTranscriptEvents({ sessionKey, sessionId, storePath })).resolves.toEqual(
        events,
      );
    },
  );

  it("reclaims orphan-only history and republishes pending archives on an empty pass", async () => {
    const now = Date.now();
    const sessionKey = "agent:main:current";
    const sessionId = "orphaned-history";
    const scope = { sessionKey, storePath };
    await replaceSessionEntry(scope, { sessionId, updatedAt: now - 600_000 });
    await replaceTranscriptEvents({ ...scope, sessionId }, [
      {
        type: "metadata",
        runId: "cleanup-reclamation-marker-orphan",
        timestamp: new Date(now - 600_000).toISOString(),
      },
    ]);
    const current = { sessionId: "current-session", updatedAt: now };
    await replaceSessionEntry(scope, current);
    const cleanup = () =>
      cleanupSessionLifecycleArtifactsCore({
        storePath,
        sessionKeySegmentPrefix: "cleanup-reclamation-",
        transcriptContentMarker: "cleanup-reclamation-marker",
        orphanTranscriptMinAgeMs: 300_000,
        nowMs: now,
      });

    await expect(cleanup()).resolves.toEqual({
      removedEntries: 0,
      archivedTranscriptArtifacts: 1,
    });
    expect(loadSessionEntry(scope)).toMatchObject(current);
    await expect(loadTranscriptEvents({ ...scope, sessionId })).resolves.toEqual([]);
    const database = openDatabase(storePath);
    const archive = database.db
      .prepare("SELECT archive_name FROM session_transcript_archives WHERE session_id = ?")
      .get(sessionId);
    if (typeof archive?.archive_name !== "string") {
      throw new Error("expected published orphan archive");
    }
    const archivePath = path.join(path.dirname(storePath), archive.archive_name);
    const bytes = fs.readFileSync(archivePath);
    fs.rmSync(archivePath);
    database.db
      .prepare("UPDATE session_transcript_archives SET published_at = NULL WHERE session_id = ?")
      .run(sessionId);

    await expect(cleanup()).resolves.toEqual({
      removedEntries: 0,
      archivedTranscriptArtifacts: 0,
    });
    expect(fs.readFileSync(archivePath)).toEqual(bytes);
    expect(
      database.db
        .prepare("SELECT published_at FROM session_transcript_archives WHERE session_id = ?")
        .get(sessionId),
    ).toEqual({ published_at: expect.any(Number) });
    expect(loadSessionEntry(scope)).toMatchObject(current);
  });

  it("keeps the event loop responsive while committing a large transcript", async () => {
    const rows = 100_000;
    const now = Date.now();
    const sessionKey = "agent:main:cleanup-reclamation-large";
    const sessionId = "cleanup-reclamation-large";
    const unrelatedKey = "agent:main:cleanup-reclamation-unrelated";
    const unrelatedSessionId = "cleanup-reclamation-unrelated";
    await replaceSessionEntry({ sessionKey, storePath }, { sessionId, updatedAt: now - 600_000 });
    await replaceSessionEntry(
      { sessionKey: unrelatedKey, storePath },
      { sessionId: unrelatedSessionId, updatedAt: now },
    );
    await replaceTranscriptEvents({ sessionKey, sessionId, storePath }, [
      {
        type: "metadata",
        runId: "cleanup-reclamation-marker",
        timestamp: new Date(now - 600_000).toISOString(),
      },
    ]);
    const database = openDatabase(storePath);
    const insert = database.db.prepare(
      "INSERT INTO transcript_events (session_id, seq, event_json, created_at) VALUES (?, ?, ?, ?)",
    );
    const eventJson = JSON.stringify({
      type: "metadata",
      runId: "cleanup-reclamation-marker",
      timestamp: new Date(now - 600_000).toISOString(),
    });
    const initialSeq = Number(
      (
        database.db
          .prepare("SELECT max(seq) AS seq FROM transcript_events WHERE session_id = ?")
          .get(sessionId) as { seq: number | bigint }
      ).seq,
    );
    // sqlite-allow-raw -- bulk fixture setup stays outside the measured cleanup commit.
    database.db.exec("BEGIN IMMEDIATE");
    try {
      for (let index = 1; index < rows; index += 1) {
        insert.run(sessionId, initialSeq + index, eventJson, now - 600_000 + index);
      }
      insert.run(
        unrelatedSessionId,
        0,
        JSON.stringify({ type: "metadata", runId: "unrelated" }),
        now,
      );
      // sqlite-allow-raw -- commits the deterministic fixture before measurement.
      database.db.exec("COMMIT");
    } catch (error) {
      // sqlite-allow-raw -- releases the failed fixture transaction.
      database.db.exec("ROLLBACK");
      throw error;
    }

    const samples: number[] = [];
    let previous = 0;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    archiveMaterializationHook.afterMaterialize = () => {
      previous = performance.now();
      heartbeat = setInterval(() => {
        const current = performance.now();
        samples.push(current - previous);
        previous = current;
      }, 10);
    };

    let result: Awaited<ReturnType<typeof cleanupSessionLifecycleArtifactsCore>>;
    try {
      result = await cleanupSessionLifecycleArtifactsCore({
        storePath,
        sessionKeySegmentPrefix: "cleanup-reclamation-large",
        transcriptContentMarker: "cleanup-reclamation-marker",
        orphanTranscriptMinAgeMs: 300_000,
        nowMs: now,
      });
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
    expect(loadSessionEntry({ sessionKey, storePath })).toBeUndefined();
    expect(loadSessionEntry({ sessionKey: unrelatedKey, storePath })).toMatchObject({
      sessionId: unrelatedSessionId,
    });
    expect(
      database.db
        .prepare("SELECT count(*) AS count FROM transcript_events WHERE session_id = ?")
        .get(sessionId),
    ).toEqual({ count: 0 });
    expect(
      database.db
        .prepare(
          "SELECT archive_sha256, published_at FROM session_transcript_archives WHERE session_id = ?",
        )
        .get(sessionId),
    ).toMatchObject({
      archive_sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      published_at: expect.any(Number),
    });
  }, 120_000);
});

function openDatabase(storePath: string) {
  const databasePath = resolveSqliteTargetFromSessionStorePath(storePath, {
    agentId: "main",
  }).path;
  if (!databasePath) {
    throw new Error("expected lifecycle-cleanup reclamation database path");
  }
  return openOpenClawAgentDatabase({ agentId: "main", path: databasePath });
}
