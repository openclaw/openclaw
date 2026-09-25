import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Worker } from "node:worker_threads";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const evictionWarnSpy = vi.hoisted(() => vi.fn());
vi.mock("../../logging/subsystem.js", async () => {
  const actual = await vi.importActual<typeof import("../../logging/subsystem.js")>(
    "../../logging/subsystem.js",
  );
  return {
    ...actual,
    createSubsystemLogger: (subsystem: string) => {
      const logger = actual.createSubsystemLogger(subsystem);
      return subsystem === "sessions/history-eviction"
        ? { ...logger, warn: evictionWarnSpy }
        : logger;
    },
  };
});
import { resetAgentRunRegistryForTest } from "../../infra/agent-run-registry.js";
import * as tmpDirOwner from "../../infra/tmp-openclaw-dir.js";
import { beginSessionWorkAdmission } from "../../sessions/session-lifecycle-admission.js";
import { closeCachedOpenClawAgentDatabase } from "../../state/openclaw-agent-db-lifecycle.js";
import {
  closeOpenClawAgentDatabaseByPathAsync,
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
} from "../../state/openclaw-agent-db.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { appendSqliteTrajectoryRuntimeEvents } from "../../trajectory/runtime-store.sqlite.js";
import type { TrajectoryEvent } from "../../trajectory/types.js";
import * as diskBudgetModule from "./disk-budget.js";
import { measureSessionPhysicalDiskUsage } from "./disk-budget.js";
import {
  appendTranscriptMessage,
  deleteSessionEntryLifecycle,
  loadTranscriptEventsSync,
  replaceSessionEntry,
  replaceSessionEntrySync,
  resetSessionEntryLifecycle,
} from "./session-accessor.js";
import * as sessionLifecycleState from "./session-accessor.sqlite-lifecycle-state.js";
import { createSessionHistoryBudgetFixture } from "./session-history-budget.test-support.js";
import {
  enforceSqliteSessionHistoryDiskBudget,
  inspectSqliteSessionHistoryDiskBudget,
  kickSessionHistoryDiskBudgetMaintenance,
} from "./session-history-eviction.js";
import * as workerReaders from "./session-transcript-worker-readers.js";
import { resolveMaintenanceConfigFromInput } from "./store-maintenance.js";

describe("SQLite historical session disk budget", () => {
  let testState: OpenClawTestState;
  let tempDir: string;
  let storePath: string;
  const {
    createHistoricalTranscript,
    database,
    settlePhysicalUsage,
    setSessionUpdatedAt,
    addRouteReference,
    sessionExists,
    readArchiveNames,
  } = createSessionHistoryBudgetFixture(() => ({ storePath, tempDir }));

  beforeEach(async () => {
    testState = await createOpenClawTestState({
      prefix: "openclaw-session-history-budget-",
      layout: "state-only",
    });
    vi.spyOn(tmpDirOwner, "resolvePreferredOpenClawTmpDir").mockReturnValue(testState.root);
    tempDir = testState.sessionsDir();
    fs.mkdirSync(tempDir, { recursive: true });
    storePath = path.join(tempDir, "sessions.json");
  });

  afterEach(async () => {
    resetAgentRunRegistryForTest();
    vi.restoreAllMocks();
    await enforceSqliteSessionHistoryDiskBudget({
      storePath,
      mode: "warn",
      maintenance: { maxDiskBytes: null, highWaterBytes: null },
    });
    await closeOpenClawAgentDatabasesAsync();
    closeOpenClawAgentDatabasesForTest();
    await testState.cleanup();
  });

  it.each(
    [
      { oldestBytes: 64 * 1024, reclaimBytes: 1, capArchive: false },
      { oldestBytes: 64 * 1024, reclaimBytes: 1, capArchive: true },
      { oldestBytes: 8 * 1024 * 1024, reclaimBytes: 4 * 1024 * 1024, capArchive: false },
      { oldestBytes: 8 * 1024 * 1024, reclaimBytes: 4 * 1024 * 1024, capArchive: true },
    ].flatMap(({ oldestBytes, reclaimBytes, capArchive }) =>
      (["worker", "in-process"] as const).map((execution) => ({
        oldestBytes,
        reclaimBytes,
        capArchive,
        execution,
      })),
    ),
  )(
    "evicts oldest history before the entry tier and reclaims $reclaimBytes bytes (cap archive: $capArchive, execution: $execution)",
    async ({ oldestBytes, reclaimBytes, capArchive, execution }) => {
      const sessionKey = "agent:main:history-order";
      await createHistoricalTranscript({
        content: "oldest " + "x".repeat(oldestBytes),
        nextSessionId: "newer-history",
        sessionId: "oldest-history",
        sessionKey,
        updatedAt: 10,
      });
      await appendTranscriptMessage(
        { sessionId: "newer-history", sessionKey, storePath },
        { message: { role: "user", content: "newer " + "y".repeat(64 * 1024) } },
      );
      await resetSessionEntryLifecycle({
        storePath,
        target: { canonicalKey: sessionKey, storeKeys: [sessionKey] },
        buildNextEntry: () => ({ sessionId: "live-history", updatedAt: 30 }),
      });
      if (capArchive) {
        replaceSessionEntrySync(
          { sessionKey, storePath },
          {
            sessionId: "live-history",
            updatedAt: 30,
            archivedAt: 40,
            archiveReason: "active-session-cap",
          },
        );
        expect(
          sessionLifecycleState.readReferencedSessionIds(database(), undefined, ["oldest-history"]),
        ).toEqual(new Set(["oldest-history"]));
      }
      setSessionUpdatedAt("newer-history", 20);
      if (execution === "worker" && oldestBytes === 64 * 1024 && !capArchive) {
        database().db.exec(`
          WITH RECURSIVE entries(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM entries WHERE n < 5000)
          INSERT INTO session_nodes (session_key, current_session_id, entry_json, updated_at)
          SELECT 'agent:main:unrelated-' || n, 'unrelated-' || n,
            json_object('sessionId', 'unrelated-' || n, 'updatedAt', 1), 1 FROM entries;
          UPDATE session_nodes SET entry_valid = 1;
        `);
      }
      await closeOpenClawAgentDatabaseByPathAsync(database().path);
      settlePhysicalUsage();
      database().db.exec("ANALYZE; PRAGMA analysis_limit = 37;");
      expect(
        database()
          .db.prepare("SELECT stat FROM sqlite_stat1 WHERE idx = ?")
          .get("idx_agent_session_windows_updated_at"),
      ).toEqual({ stat: expect.stringMatching(/^3\b/u) });
      settlePhysicalUsage();
      const before = await measureSessionPhysicalDiskUsage(storePath);
      const highWaterBytes = before.totalBytes - reclaimBytes;

      let reclamationWorkers = 0;
      type ArchiveReply = {
        type: string;
        operationId?: number;
        settled?: boolean;
        result?: { kind: string };
      };
      const archiveReplies: Array<{ worker: Worker; message: ArchiveReply }> = [];
      const observeWorker = (worker: Worker) => {
        worker.on("message", (message: ArchiveReply | null | undefined) => {
          if (message?.type === "reclaimed" && message.result?.kind === "history-eviction") {
            reclamationWorkers += 1;
          }
          if (message?.type === "done" || message?.type === "published") {
            archiveReplies.push({ worker, message });
          }
        });
      };
      process.on("worker", observeWorker);
      const references = vi.spyOn(sessionLifecycleState, "readReferencedSessionIds");
      let result: Awaited<ReturnType<typeof enforceSqliteSessionHistoryDiskBudget>>;
      try {
        result = await enforceSqliteSessionHistoryDiskBudget({
          storePath,
          mode: "enforce",
          ...(execution === "in-process" ? { reclamationMode: execution } : {}),
          maintenance: {
            maxDiskBytes: before.totalBytes - 1,
            highWaterBytes,
          },
        });
      } finally {
        process.off("worker", observeWorker);
      }

      const hostDiscoveryScans = references.mock.calls.filter(
        (call) => call[2] === undefined,
      ).length;
      const hostReferenceScans = references.mock.calls.length;
      console.info("history eviction host reference scans", {
        execution,
        hostDiscoveryScans,
        hostReferenceScans,
      });
      expect(hostDiscoveryScans).toBe(execution === "in-process" ? 1 : 0);
      if (execution === "worker") {
        expect(hostReferenceScans).toBe(0);
      }
      expect(reclamationWorkers).toBe(execution === "in-process" ? 0 : 1);
      expect(archiveReplies.map(({ message }) => message.type)).toEqual(["done", "published"]);
      expect(new Set(archiveReplies.map(({ worker }) => worker)).size).toBe(1);
      expect(archiveReplies.every(({ worker }) => worker.threadId === -1)).toBe(true);
      expect(archiveReplies.map(({ message }) => message)).toMatchObject([
        { operationId: 1, settled: true },
        { operationId: 2, settled: true },
      ]);
      expect(result?.removedEntries).toBe(1);
      expect(result?.totalBytesAfter).toBeLessThanOrEqual(highWaterBytes);
      expect(result?.totalBytesAfter).toBe(
        (await measureSessionPhysicalDiskUsage(storePath)).totalBytes,
      );
      expect(sessionExists("oldest-history")).toBe(false);
      expect(sessionExists("newer-history")).toBe(true);
      expect(sessionExists("live-history")).toBe(true);
      expect(readArchiveNames("oldest-history")).toHaveLength(1);
      expect(readArchiveNames("newer-history")).toHaveLength(0);
      expect(
        database()
          .db.prepare("SELECT stat FROM sqlite_stat1 WHERE idx = ?")
          .get("idx_agent_session_windows_updated_at"),
      ).toEqual({ stat: expect.stringMatching(/^3\b/u) });
      expect(database().db.prepare("PRAGMA analysis_limit").get()).toEqual({ analysis_limit: 37 });
    },
  );

  it("pages past protected archives to evict cap-created sessions under pressure", async () => {
    const capKey = "agent:main:explicit:cap-archived";
    const manualKey = "agent:main:explicit:manual-archived";
    const legacyKey = "agent:main:explicit:legacy-archived";
    await replaceSessionEntry(
      { sessionKey: capKey, storePath },
      {
        sessionId: "cap-archived",
        updatedAt: 1,
        archivedAt: 1,
        archiveReason: "active-session-cap",
      },
    );
    await appendTranscriptMessage(
      { sessionId: "cap-archived", sessionKey: capKey, storePath },
      { message: { role: "user", content: "cap archive " + "x".repeat(64 * 1024) } },
    );
    await replaceSessionEntry(
      { sessionKey: manualKey, storePath },
      {
        sessionId: "manual-archived",
        updatedAt: 2,
        archivedAt: 2,
        archiveReason: "manual",
      },
    );
    await appendTranscriptMessage(
      { sessionId: "manual-archived", sessionKey: manualKey, storePath },
      { message: { role: "user", content: "manual archive " + "y".repeat(64 * 1024) } },
    );
    await replaceSessionEntry(
      { sessionKey: legacyKey, storePath },
      { sessionId: "legacy-archived", updatedAt: 3, archivedAt: 3 },
    );
    for (let index = 0; index < 70; index += 1) {
      await replaceSessionEntry(
        { sessionKey: `agent:main:explicit:legacy-${index}`, storePath },
        {
          sessionId: `legacy-${index}`,
          updatedAt: index + 4,
          archivedAt: index + 4,
        },
      );
    }
    await replaceSessionEntry(
      { sessionKey: capKey, storePath },
      {
        sessionId: "cap-archived",
        updatedAt: 100,
        archivedAt: 100,
        archiveReason: "active-session-cap",
      },
    );
    settlePhysicalUsage();
    const before = await measureSessionPhysicalDiskUsage(storePath);
    const maintenance = { maxDiskBytes: before.totalBytes - 1, highWaterBytes: 1 };

    await expect(
      inspectSqliteSessionHistoryDiskBudget({ storePath, mode: "enforce", maintenance }),
    ).resolves.toMatchObject({ wouldMutate: true });
    const result = await enforceSqliteSessionHistoryDiskBudget({
      storePath,
      mode: "enforce",
      maintenance,
    });

    expect(result?.removedEntries).toBe(1);
    expect(sessionExists("cap-archived")).toBe(false);
    expect(sessionExists("manual-archived")).toBe(true);
    expect(sessionExists("legacy-archived")).toBe(true);
    expect(sessionExists("legacy-69")).toBe(true);
    expect(readArchiveNames("cap-archived")).toHaveLength(0);
  });

  it("remeasures incompressible archive publication before declaring high water", async () => {
    const sessionId = "incompressible-history";
    const sessionKey = "agent:main:incompressible-history";
    await createHistoricalTranscript({
      content: randomBytes(192 * 1024).toString("base64"),
      nextSessionId: "incompressible-live",
      sessionId,
      sessionKey,
      updatedAt: 1,
    });
    settlePhysicalUsage();
    const before = await measureSessionPhysicalDiskUsage(storePath);
    const highWaterBytes = before.totalBytes - 1;

    const result = await enforceSqliteSessionHistoryDiskBudget({
      storePath,
      mode: "enforce",
      maintenance: {
        maxDiskBytes: highWaterBytes,
        highWaterBytes,
      },
    });
    const actualAfter = await measureSessionPhysicalDiskUsage(storePath);

    expect(result?.removedEntries).toBe(1);
    expect(result?.totalBytesAfter).toBe(actualAfter.totalBytes);
    expect(actualAfter.totalBytes).toBeLessThanOrEqual(highWaterBytes);
    expect(sessionExists(sessionId)).toBe(false);
  });

  it.each([
    {
      archiveName: "already-extracted.jsonl.deleted.2026-01-01T00-00-00.000Z",
      kind: "deleted transcript archive",
    },
    {
      archiveName: `legacy-compact.jsonl.bak.2026-01-01T00-00-00.000Z.${"a".repeat(32)}.zst`,
      kind: "legacy compact backup",
    },
  ])("removes a $kind before evicting searchable history", async ({ archiveName }) => {
    await createHistoricalTranscript({
      content: "keep searchable history",
      nextSessionId: "archive-live",
      sessionId: "archive-history",
      sessionKey: "agent:main:archive-pressure",
      updatedAt: 1,
    });
    database().walMaintenance.checkpoint();
    const oldArchive = path.join(tempDir, archiveName);
    fs.writeFileSync(oldArchive, Buffer.alloc(256 * 1024));
    const before = await measureSessionPhysicalDiskUsage(storePath);
    const readReferences = vi.spyOn(sessionLifecycleState, "readReferencedSessionIds");

    const result = await enforceSqliteSessionHistoryDiskBudget({
      env: { OPENCLAW_STATE_DIR: testState.stateDir },
      storePath,
      mode: "enforce",
      maintenance: {
        maxDiskBytes: before.totalBytes - 1,
        highWaterBytes: before.totalBytes - 64 * 1024,
      },
    });

    expect(result).toMatchObject({ removedEntries: 0, removedFiles: 1 });
    expect(fs.existsSync(oldArchive)).toBe(false);
    expect(sessionExists("archive-history")).toBe(true);
    expect(readReferences.mock.calls.length).toBe(0);
  });

  it("prunes the canonical archive row and its derived file before searchable history", async () => {
    const archivedSessionId = "canonical-archive";
    const archivedSessionKey = "agent:main:canonical-archive";
    await replaceSessionEntry(
      { sessionKey: archivedSessionKey, storePath },
      { sessionId: archivedSessionId, updatedAt: 1 },
    );
    await appendTranscriptMessage(
      { sessionId: archivedSessionId, sessionKey: archivedSessionKey, storePath },
      { message: { role: "user", content: "canonical archive pressure" } },
    );
    const deleted = await deleteSessionEntryLifecycle({
      archiveTranscript: true,
      storePath,
      target: { canonicalKey: archivedSessionKey, storeKeys: [archivedSessionKey] },
    });
    const archivePath = deleted.archivedTranscripts[0]?.archivedPath;
    expect(archivePath).toBeTruthy();

    await createHistoricalTranscript({
      content: "keep searchable history",
      nextSessionId: "canonical-live",
      sessionId: "canonical-history",
      sessionKey: "agent:main:canonical-pressure",
      updatedAt: 2,
    });
    settlePhysicalUsage();
    const before = await measureSessionPhysicalDiskUsage(storePath);

    const cachedDatabase = database();
    const rm = fs.promises.rm.bind(fs.promises);
    const removeArchive = vi.spyOn(fs.promises, "rm").mockImplementation(async (...args) => {
      if (args[0] === archivePath) {
        expect(cachedDatabase.db.isOpen).toBe(true);
        closeCachedOpenClawAgentDatabase(cachedDatabase, { eviction: true });
        expect(cachedDatabase.db.isOpen).toBe(false);
      }
      return await rm(...args);
    });
    const result = await enforceSqliteSessionHistoryDiskBudget({
      storePath,
      mode: "enforce",
      maintenance: {
        maxDiskBytes: before.totalBytes - 1,
        highWaterBytes: before.totalBytes - 1,
      },
    });

    expect(result).toMatchObject({ removedEntries: 0, removedFiles: 1 });
    expect(fs.existsSync(archivePath ?? "")).toBe(false);
    expect(removeArchive).toHaveBeenCalledWith(archivePath);
    expect(
      database()
        .db.prepare("SELECT 1 FROM session_transcript_archives WHERE session_id = ?")
        .get(archivedSessionId),
    ).toBeUndefined();
    expect(sessionExists("canonical-history")).toBe(true);
  });

  it("never prunes an unpublished canonical archive under disk pressure", async () => {
    const sessionId = "pending-pressure";
    const sessionKey = "agent:main:pending-pressure";
    await replaceSessionEntry({ sessionKey, storePath }, { sessionId, updatedAt: Date.now() });
    await appendTranscriptMessage(
      { sessionId, sessionKey, storePath },
      { message: { role: "user", content: "sole crash-recovery copy" } },
    );
    const deleted = await deleteSessionEntryLifecycle({
      archiveTranscript: true,
      storePath,
      target: { canonicalKey: sessionKey, storeKeys: [sessionKey] },
    });
    const pendingArchivePath = deleted.archivedTranscripts[0]?.archivedPath;
    database()
      .db.prepare("UPDATE session_transcript_archives SET published_at = NULL WHERE session_id = ?")
      .run(sessionId);
    settlePhysicalUsage();
    const before = await measureSessionPhysicalDiskUsage(storePath);

    const result = await enforceSqliteSessionHistoryDiskBudget({
      storePath,
      mode: "enforce",
      maintenance: {
        maxDiskBytes: before.totalBytes - 1,
        highWaterBytes: before.totalBytes - 1,
      },
    });

    expect(result).toMatchObject({ removedEntries: 0, removedFiles: 0 });
    expect(
      database()
        .db.prepare("SELECT published_at FROM session_transcript_archives WHERE session_id = ?")
        .get(sessionId),
    ).toEqual({ published_at: null });
    expect(fs.existsSync(pendingArchivePath ?? "")).toBe(true);
  });

  it("excludes entry, route, and admitted ids while evicting trajectory-only history", async () => {
    const sessionKey = "agent:main:history-protection";
    await replaceSessionEntry(
      { sessionKey, storePath },
      { sessionId: "admitted-history", updatedAt: 1 },
    );
    await appendTranscriptMessage(
      { sessionId: "admitted-history", sessionKey, storePath },
      { message: { role: "user", content: "admitted" } },
    );
    await resetSessionEntryLifecycle({
      storePath,
      target: { canonicalKey: sessionKey, storeKeys: [sessionKey] },
      buildNextEntry: () => ({ sessionId: "route-history", updatedAt: 2 }),
    });
    await appendTranscriptMessage(
      { sessionId: "route-history", sessionKey, storePath },
      { message: { role: "user", content: "route protected" } },
    );
    await resetSessionEntryLifecycle({
      storePath,
      target: { canonicalKey: sessionKey, storeKeys: [sessionKey] },
      buildNextEntry: () => ({ sessionId: "trajectory-history", updatedAt: 3 }),
    });
    appendSqliteTrajectoryRuntimeEvents({ sessionId: "trajectory-history", storePath }, [
      createTrajectoryEvent("trajectory-history", sessionKey),
    ]);
    await resetSessionEntryLifecycle({
      storePath,
      target: { canonicalKey: sessionKey, storeKeys: [sessionKey] },
      buildNextEntry: () => ({ sessionId: "live-history", updatedAt: 4 }),
    });
    addRouteReference("route-only", "route-history");
    const admission = await beginSessionWorkAdmission({
      scope: storePath,
      identities: ["admitted-history"],
      assertAllowed: () => {},
    });
    try {
      const before = await measureSessionPhysicalDiskUsage(storePath);
      const result = await enforceSqliteSessionHistoryDiskBudget({
        storePath,
        mode: "enforce",
        maintenance: { maxDiskBytes: before.totalBytes - 1, highWaterBytes: 0 },
      });

      expect(result?.removedEntries).toBe(1);
      expect(sessionExists("trajectory-history")).toBe(false);
      // Trajectory-only sessions carry no transcript; eviction reclaims their
      // diagnostic telemetry without writing an empty archive artifact.
      expect(readArchiveNames("trajectory-history")).toHaveLength(0);
      expect(sessionExists("admitted-history")).toBe(true);
      expect(sessionExists("route-history")).toBe(true);
      expect(sessionExists("live-history")).toBe(true);
    } finally {
      admission.release();
    }
  });

  it.each(["archivedAt", "pinnedAt", "age-retention", "manual", "recent"] as const)(
    "rechecks %s on the logical owner before deleting an older generation",
    async (field) => {
      const sessionKey = "agent:main:archive-race";
      await createHistoricalTranscript({
        content: "keep this older generation",
        nextSessionId: "race-live",
        sessionId: "race-old",
        sessionKey,
        updatedAt: Date.now() - 8 * 24 * 60 * 60 * 1000,
      });
      replaceSessionEntrySync(
        { sessionKey, storePath },
        {
          sessionId: "race-live",
          updatedAt: Date.now() - 8 * 24 * 60 * 60 * 1000,
          archivedAt: Date.now(),
          archiveReason: "active-session-cap",
        },
      );
      const reclamation = await import("./session-accessor.sqlite-reclamation.js");
      const reclaim = reclamation.runSqliteSessionReclamation;
      const historyRequests: string[] = [];
      let protectionChanged = false;
      vi.spyOn(reclamation, "runSqliteSessionReclamation").mockImplementation(async (params) => {
        // Automatic entry planning shares this transport; inject only at the history attempt.
        if (params.plan.kind === "history-eviction") {
          historyRequests.push(params.plan.sessionId);
          if (params.plan.sessionId === "race-old") {
            expect(protectionChanged).toBe(false);
            replaceSessionEntrySync(
              { sessionKey, storePath },
              {
                sessionId: "race-live",
                updatedAt: Date.now(),
                ...(field === "age-retention" || field === "manual"
                  ? { archivedAt: Date.now(), archiveReason: field }
                  : field === "recent"
                    ? {}
                    : { [field]: Date.now() }),
              },
            );
            protectionChanged = true;
          }
        }
        return await reclaim(params);
      });
      expect(
        await enforceSqliteSessionHistoryDiskBudget({
          storePath,
          mode: "enforce",
          maintenance: {
            maxDiskBytes: 1,
            highWaterBytes: 1,
            ...(field === "recent" ? { preserveRecentMs: 7 * 24 * 60 * 60 * 1000 } : {}),
          },
        }),
      ).toMatchObject({ removedEntries: 0 });
      expect(historyRequests).toEqual(["race-old"]);
      expect(protectionChanged).toBe(true);
      expect(
        loadTranscriptEventsSync({ sessionId: "race-old", sessionKey, storePath }),
      ).not.toEqual([]);
      expect(readArchiveNames("race-old")).toEqual([]);
      // An explicit operator delete still owns every generation, even when pinned or archived.
      expect(
        await deleteSessionEntryLifecycle({
          storePath,
          target: { canonicalKey: sessionKey, storeKeys: [sessionKey] },
          archiveTranscript: true,
        }),
      ).toMatchObject({ deleted: true });
      expect(sessionExists("race-old")).toBe(false);
    },
  );

  it.each([
    { writerKind: "same connection", after: "discovery" },
    { writerKind: "external connection", after: "materialization" },
  ] as const)(
    "rechecks cross-owner references written through a $writerKind after $after",
    async ({ writerKind, after }) => {
      const sessionKey = "agent:main:reference-race";
      const referringKey = "agent:main:reference-survivor";
      await createHistoricalTranscript({
        content: "retain cross-owner history",
        nextSessionId: "reference-live",
        sessionId: "reference-old",
        sessionKey,
        updatedAt: Date.now(),
      });
      const archive = await import("./session-accessor.sqlite-archive.js");
      const materialize = archive.materializeSessionStateDeletePlans;
      const addReference = () => {
        const owner = database();
        const writer =
          writerKind === "external connection" ? new DatabaseSync(owner.path) : owner.db;
        try {
          writer
            .prepare(
              "INSERT INTO session_nodes (session_key, current_session_id, entry_json, updated_at) VALUES (?, ?, ?, 1)",
            )
            .run(
              referringKey,
              "survivor-current",
              JSON.stringify({
                sessionId: "survivor-current",
                updatedAt: 1,
                usageFamilySessionIds: ["reference-old"],
              }),
            );
          // Complete the canonical writer's validity settlement for this healthy fixture row.
          writer
            .prepare("UPDATE session_nodes SET entry_valid = 1 WHERE session_key = ?")
            .run(referringKey);
        } finally {
          if (writer !== owner.db) {
            writer.close();
          }
        }
      };
      if (after === "discovery") {
        const createReaders = workerReaders.createSessionHistoryWorkerReaders;
        vi.spyOn(workerReaders, "createSessionHistoryWorkerReaders").mockImplementation((run) => {
          const readers = createReaders(run);
          const discover = readers.readHistoricalEvictionCandidates;
          readers.readHistoricalEvictionCandidates = async (input) => {
            const candidates = await discover(input);
            addReference();
            return candidates;
          };
          return readers;
        });
      }
      const materialization = vi
        .spyOn(archive, "materializeSessionStateDeletePlans")
        .mockImplementationOnce(async (plans) => {
          const prepared = await materialize(plans);
          if (after === "materialization") {
            addReference();
          }
          return prepared;
        });
      expect(
        await enforceSqliteSessionHistoryDiskBudget({
          storePath,
          mode: "enforce",
          maintenance: { maxDiskBytes: 1, highWaterBytes: 1 },
        }),
      ).toMatchObject({ removedEntries: 0 });
      expect(materialization).toHaveBeenCalledOnce();
      expect(
        loadTranscriptEventsSync({ sessionId: "reference-old", sessionKey, storePath }),
      ).not.toEqual([]);
      expect(readArchiveNames("reference-old")).toEqual([]);
      // Excluding the deliberately deleted owner must not exclude a surviving reference.
      expect(
        await deleteSessionEntryLifecycle({
          storePath,
          target: { canonicalKey: sessionKey, storeKeys: [sessionKey] },
          archiveTranscript: true,
        }),
      ).toMatchObject({ deleted: true });
      expect(sessionExists("reference-old")).toBe(true);
      expect(
        loadTranscriptEventsSync({
          sessionId: "reference-old",
          sessionKey: referringKey,
          storePath,
        }),
      ).not.toEqual([]);
    },
  );

  it("coalesces forced kicks during and after a sweep until the one-minute interval expires", async () => {
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    const measurement = vi
      .spyOn(diskBudgetModule, "measureSessionPhysicalDiskUsage")
      .mockResolvedValue({
        databaseMainBytes: 0,
        databaseWalBytes: 0,
        sessionFilesBytes: 0,
        totalBytes: 0,
      });
    const maintenanceConfig = resolveMaintenanceConfigFromInput({
      mode: "enforce",
      maxDiskBytes: 1,
      highWaterBytes: 1,
    });
    const kick = () =>
      kickSessionHistoryDiskBudgetMaintenance({ storePath, force: true, maintenanceConfig });
    const settle = async () => {
      await enforceSqliteSessionHistoryDiskBudget({
        storePath,
        mode: "warn",
        maintenance: { maxDiskBytes: null, highWaterBytes: null },
      });
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
    };
    kick();
    for (let index = 0; index < 10; index++) {
      kick();
    }
    await settle();
    expect(measurement).toHaveBeenCalledOnce();

    clock.mockReturnValue(now + 59_999);
    kick();
    await settle();
    expect(measurement).toHaveBeenCalledOnce();

    clock.mockReturnValue(now + 60_000);
    kick();
    await settle();
    expect(measurement).toHaveBeenCalledTimes(2);
  });

  it("backs off protected over-budget history and warns once while manual cleanup remains immediate", async () => {
    await createHistoricalTranscript({
      content: "protected history",
      nextSessionId: "protected-live",
      sessionId: "protected-old",
      sessionKey: "agent:main:protected-history",
      updatedAt: 1,
    });
    addRouteReference("agent:main:shared-history", "protected-old");
    const settle = async () => {
      await enforceSqliteSessionHistoryDiskBudget({
        storePath,
        mode: "warn",
        maintenance: { maxDiskBytes: null, highWaterBytes: null },
      });
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
    };
    await settle();
    evictionWarnSpy.mockClear();
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    const references = vi.fn();
    const createReaders = workerReaders.createSessionHistoryWorkerReaders;
    vi.spyOn(workerReaders, "createSessionHistoryWorkerReaders").mockImplementation((run) => {
      const readers = createReaders(run);
      const discover = readers.readHistoricalEvictionCandidates;
      readers.readHistoricalEvictionCandidates = (input) => {
        references();
        return discover(input);
      };
      return readers;
    });
    const maintenanceConfig = resolveMaintenanceConfigFromInput({
      mode: "enforce",
      maxDiskBytes: 1,
      highWaterBytes: 1,
    });
    const kick = () =>
      kickSessionHistoryDiskBudgetMaintenance({ storePath, force: true, maintenanceConfig });
    await expect(
      enforceSqliteSessionHistoryDiskBudget({
        storePath,
        mode: "enforce",
        maintenance: maintenanceConfig,
      }),
    ).resolves.toMatchObject({ overBudget: true, removedEntries: 0 });
    const firstScans = references.mock.calls.length;
    expect(firstScans).toBeGreaterThan(0);
    expect(evictionWarnSpy).toHaveBeenCalledOnce();
    expect(evictionWarnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Raise session.maintenance.maxDiskBytes or export and delete"),
      expect.objectContaining({ storePath, nextCheckAt: now + 30 * 60_000 }),
    );

    clock.mockReturnValue(now + 60_000);
    for (let index = 0; index < 10; index++) {
      kick();
    }
    await settle();
    expect(references).toHaveBeenCalledTimes(firstScans);

    await expect(
      enforceSqliteSessionHistoryDiskBudget({
        storePath,
        mode: "enforce",
        maintenance: maintenanceConfig,
      }),
    ).resolves.toMatchObject({ overBudget: true, removedEntries: 0 });
    const manualScans = references.mock.calls.length;
    expect(manualScans).toBeGreaterThan(firstScans);

    clock.mockReturnValue(now + 31 * 60_000);
    kick();
    await settle();
    expect(references.mock.calls.length).toBeGreaterThan(manualScans);
    expect(evictionWarnSpy).toHaveBeenCalledOnce();
    expect(sessionExists("protected-old")).toBe(true);
    expect(sessionExists("protected-live")).toBe(true);
  });

  it("warns when a fire-and-forget budget sweep fails instead of swallowing it", async () => {
    evictionWarnSpy.mockClear();
    vi.spyOn(diskBudgetModule, "measureSessionPhysicalDiskUsage").mockRejectedValueOnce(
      new Error("sweep exploded"),
    );
    const maintenanceConfig = resolveMaintenanceConfigFromInput({
      mode: "enforce",
      maxDiskBytes: 1,
      highWaterBytes: 1,
    });

    kickSessionHistoryDiskBudgetMaintenance({ storePath, force: true, maintenanceConfig });
    await vi.waitFor(() => {
      expect(evictionWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining("disk-budget sweep failed"),
        expect.objectContaining({ storePath }),
      );
    });
  });

  it("inspects history after the archive probe loses its cached handle", async () => {
    await createHistoricalTranscript({
      content: "inspect retained history",
      nextSessionId: "inspect-live",
      sessionId: "inspect-old",
      sessionKey: "agent:main:inspect-history",
      updatedAt: 1,
    });
    const databasePath = database().path;
    const diskBudget = await import("./disk-budget.js");
    const probe = diskBudget.hasRetainedSessionTranscriptArchives;
    const probeSpy = vi
      .spyOn(diskBudget, "hasRetainedSessionTranscriptArchives")
      .mockImplementation(async (pathname) => {
        const retained = await probe(pathname);
        expect(await closeOpenClawAgentDatabaseByPathAsync(databasePath)).toBe(true);
        return retained;
      });

    await expect(
      inspectSqliteSessionHistoryDiskBudget({
        storePath,
        mode: "enforce",
        maintenance: { maxDiskBytes: 1, highWaterBytes: 0 },
      }),
    ).resolves.toMatchObject({ wouldMutate: true });
    expect(probeSpy).toHaveBeenCalledOnce();
    expect(sessionExists("inspect-old")).toBe(true);
  });

  it("warn mode reports physical overage without extracting or deleting history", async () => {
    await createHistoricalTranscript({
      content: "warn history",
      nextSessionId: "warn-live",
      sessionId: "warn-old",
      sessionKey: "agent:main:warn-history",
      updatedAt: 1,
    });
    const before = await measureSessionPhysicalDiskUsage(storePath);

    const inspected = await inspectSqliteSessionHistoryDiskBudget({
      storePath,
      mode: "warn",
      maintenance: { maxDiskBytes: before.totalBytes - 1, highWaterBytes: 0 },
    });
    const result = await enforceSqliteSessionHistoryDiskBudget({
      storePath,
      mode: "warn",
      maintenance: { maxDiskBytes: before.totalBytes - 1, highWaterBytes: 0 },
    });

    expect(inspected.diskBudget?.totalBytesBefore).toBe(before.totalBytes);
    expect(inspected.wouldMutate).toBe(false);
    expect(result).toMatchObject({ overBudget: true, removedEntries: 0, removedFiles: 0 });
    expect(sessionExists("warn-old")).toBe(true);
    expect(readArchiveNames("warn-old")).toHaveLength(0);
  });
});

function createTrajectoryEvent(sessionId: string, sessionKey: string): TrajectoryEvent {
  return {
    traceSchema: "openclaw-trajectory",
    schemaVersion: 1,
    traceId: sessionId,
    source: "runtime",
    type: "history.test",
    ts: "2026-07-18T00:00:00.000Z",
    seq: 1,
    sessionId,
    sessionKey,
  };
}
