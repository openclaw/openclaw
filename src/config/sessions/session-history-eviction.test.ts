import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Worker } from "node:worker_threads";
import { describe, expect, it, vi } from "vitest";
import { trackSqliteStatementExecutions } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { requireNativeSqliteDatabase } from "../../test-utils/native-sqlite.js";

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
import { acquireGatewayStateOwner } from "../../infra/gateway-state-owner.js";
import * as sqliteQueries from "../../infra/kysely-sync.js";
import { withSessionTurn } from "../../sessions/session-controller.admission.js";
import { beginSessionEffect } from "../../sessions/session-controller.lifecycle.js";
import { closeCachedOpenClawAgentDatabase } from "../../state/openclaw-agent-db-lifecycle.js";
import { closeOpenClawAgentDatabaseByPathAsync } from "../../state/openclaw-agent-db.js";
import { createOpenClawDatabaseMaintenanceScope } from "../../state/openclaw-state-db-async-lifecycle.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import type { OpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { appendSqliteTrajectoryRuntimeEvents } from "../../trajectory/runtime-store.test-support.js";
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
import { loadSessionEntryReadOnly } from "./session-accessor.sqlite-entry.js";
import * as sessionLifecycleState from "./session-accessor.sqlite-lifecycle-state.js";
import * as archivePruning from "./session-history-archive-pruning.js";
import { installHistoryBudgetState } from "./session-history-budget-state.test-support.js";
import { createSessionHistoryBudgetFixture } from "./session-history-budget.test-support.js";
import {
  enforceSqliteSessionHistoryDiskBudget,
  inspectSqliteSessionHistoryDiskBudget,
  kickSessionHistoryDiskBudgetMaintenance,
} from "./session-history-eviction.js";
import { deriveSessionPredicateColumns } from "./session-predicate-columns.js";
import * as workerReaders from "./session-transcript-worker-readers.js";
import { resolveMaintenanceConfigFromInput } from "./store-maintenance.js";
import type { SessionEntry } from "./types.js";

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

  installHistoryBudgetState("openclaw-session-history-budget-", (state, dir, store) => {
    testState = state;
    tempDir = dir;
    storePath = store;
  });

  const budget = (
    maxDiskBytes = 1,
    highWaterBytes = maxDiskBytes,
    mode: "enforce" | "warn" = "enforce",
  ) => ({ storePath, mode, maintenance: { maxDiskBytes, highWaterBytes } });
  const enforce = (maxDiskBytes = 1, highWaterBytes = maxDiskBytes) =>
    enforceSqliteSessionHistoryDiskBudget(budget(maxDiskBytes, highWaterBytes));
  const history = (
    sessionId: string,
    nextSessionId: string,
    sessionKey: string,
    content: string,
    updatedAt = 1,
  ) => createHistoricalTranscript({ sessionId, nextSessionId, sessionKey, content, updatedAt });
  const entry = (sessionKey: string, value: SessionEntry) =>
    replaceSessionEntry({ sessionKey, storePath }, value);
  const entrySync = (sessionKey: string, value: SessionEntry) =>
    replaceSessionEntrySync({ sessionKey, storePath }, value);
  const readTranscript = (sessionId: string, sessionKey: string) =>
    loadTranscriptEventsSync({ sessionId, sessionKey, storePath });
  const expectSessions = (expected: Record<string, boolean>) =>
    expect(Object.fromEntries(Object.keys(expected).map((id) => [id, sessionExists(id)]))).toEqual(
      expected,
    );
  const windowStatistics = () =>
    database()
      .db.prepare("SELECT stat FROM sqlite_stat1 WHERE idx = ?")
      .get("idx_agent_session_windows_updated_at");
  const seed = (name: string, content = "history", updatedAt = 1) =>
    history(`${name}-old`, `${name}-live`, `agent:main:${name}`, content, updatedAt);
  const observeDiscovery = (effect: () => void, before = false) => {
    const create = workerReaders.createSessionHistoryWorkerReaders;
    vi.spyOn(workerReaders, "createSessionHistoryWorkerReaders").mockImplementation((run) => {
      const readers = create(run);
      const discover = readers.readHistoricalEvictionCandidates;
      readers.readHistoricalEvictionCandidates = async (input) => {
        if (before) {
          effect();
        }
        const candidates = await discover(input);
        if (!before) {
          effect();
        }
        return candidates;
      };
      return readers;
    });
  };
  const append = (sessionKey: string, sessionId: string, content: string) =>
    appendTranscriptMessage(
      { sessionId, sessionKey, storePath },
      { message: { role: "user", content } },
    );
  const reset = (sessionKey: string, sessionId: string, updatedAt: number) =>
    resetSessionEntryLifecycle({
      storePath,
      target: { canonicalKey: sessionKey, storeKeys: [sessionKey] },
      buildNextEntry: () => ({ sessionId, updatedAt }),
    });
  const remove = (sessionKey: string) =>
    deleteSessionEntryLifecycle({
      storePath,
      target: { canonicalKey: sessionKey, storeKeys: [sessionKey] },
      archiveTranscript: true,
    });
  const archiveSession = async (sessionId: string, updatedAt = 1) => {
    const sessionKey = `agent:main:${sessionId}`;
    await entry(sessionKey, { sessionId, updatedAt });
    await append(sessionKey, sessionId, "archive");
    return (await remove(sessionKey)).archivedTranscripts[0]?.archivedPath;
  };
  const expectRetainedHistory = (sessionId: string, sessionKey: string) => {
    expect(readTranscript(sessionId, sessionKey)).not.toEqual([]);
    expect(readArchiveNames(sessionId)).toEqual([]);
  };
  const defaultMaintenance = () =>
    resolveMaintenanceConfigFromInput({ mode: "enforce", ...budget().maintenance });

  it.each([
    [64 * 1024, 1, false, "worker"],
    [8 * 1024 * 1024, 4 * 1024 * 1024, true, "in-process"],
  ] as const)(
    "evicts oldest history before the entry tier (%i bytes, reclaim %i, cap archive: %s, execution: %s)",
    async (oldestBytes, reclaimBytes, capArchive, execution) => {
      const run = async () => {
        const sessionKey = "agent:main:history-order";
        await history("oldest-history", "newer-history", sessionKey, "x".repeat(oldestBytes), 10);
        await append(sessionKey, "newer-history", "newer " + "y".repeat(64 * 1024));
        await reset(sessionKey, "live-history", 30);
        if (capArchive) {
          entrySync(sessionKey, {
            sessionId: "live-history",
            updatedAt: 30,
            archivedAt: 40,
            archiveReason: "active-session-cap",
          });
          expect(
            sessionLifecycleState.readReferencedSessionIds(database(), undefined, [
              "oldest-history",
            ]),
          ).toEqual(new Set(["oldest-history"]));
        }
        setSessionUpdatedAt("newer-history", 20);
        if (execution === "worker") {
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
        expect(windowStatistics()).toEqual({ stat: expect.stringMatching(/^3\b/u) });
        settlePhysicalUsage();
        const before = await measureSessionPhysicalDiskUsage(storePath);
        const highWaterBytes = before.totalBytes - reclaimBytes;

        let reclamationWorkers = 0;
        type ArchiveReply = {
          type: string;
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
            ...budget(before.totalBytes - 1, highWaterBytes),
            ...(execution === "in-process" ? { reclamationMode: execution } : {}),
          });
        } finally {
          process.off("worker", observeWorker);
        }

        const hostDiscoveryScans = references.mock.calls.filter(
          (call) => call[2] === undefined,
        ).length;
        expect(hostDiscoveryScans).toBe(execution === "in-process" ? 1 : 0);
        if (execution === "worker") {
          expect(references.mock.calls.length).toBe(0);
        }
        expect(reclamationWorkers).toBe(execution === "in-process" ? 0 : 1);
        expect(archiveReplies.map(({ message }) => message.type)).toEqual(["done", "published"]);
        expect(new Set(archiveReplies.map(({ worker }) => worker)).size).toBe(1);
        expect(archiveReplies.every(({ worker }) => worker.threadId > 0)).toBe(true);
        expect(result?.removedEntries).toBe(1);
        expect(result?.totalBytesAfter).toBeLessThanOrEqual(highWaterBytes);
        expect(result?.totalBytesAfter).toBe(
          (await measureSessionPhysicalDiskUsage(storePath)).totalBytes,
        );
        expectSessions({ "oldest-history": false, "newer-history": true, "live-history": true });
        expect(readArchiveNames("oldest-history")).toHaveLength(1);
        expect(readArchiveNames("newer-history")).toHaveLength(0);
        expect(windowStatistics()).toEqual({ stat: expect.stringMatching(/^3\b/u) });
        expect(database().db.prepare("PRAGMA analysis_limit").get()).toEqual({
          analysis_limit: 37,
        });
        await closeOpenClawAgentDatabaseByPathAsync(database().path);
        expect(archiveReplies.every(({ worker }) => worker.threadId === -1)).toBe(true);
      };
      if (execution === "worker") {
        await run();
        return;
      }
      const stateDatabase = openOpenClawStateDatabase({ env: testState.env });
      const owner = acquireGatewayStateOwner({ databasePath: stateDatabase.path });
      const maintenance = createOpenClawDatabaseMaintenanceScope({
        schemaMaintenance: true,
        assertOwnerCurrent: owner.assertCurrent,
        assertDatabaseAccess: owner.assertDatabaseAccess,
      });
      try {
        await maintenance.run(run);
      } finally {
        await maintenance.close();
        owner.release();
      }
    },
  );

  it("evicts bulk historical generations without analyzing unchanged session entries", async () => {
    for (let index = 0; index < 65; index++) {
      await seed(`bulk-${index}`, "Historical generation " + index, index + 1);
    }
    settlePhysicalUsage();
    database().db.exec("ANALYZE;");
    expect(windowStatistics()).toEqual({ stat: expect.stringMatching(/^130\b/u) });

    const result = await enforce();

    expect(result?.removedEntries).toBe(65);
    expect(database().db.prepare("SELECT COUNT(*) AS count FROM session_windows").get()).toEqual({
      count: 65,
    });
    for (let index = 0; index < 65; index++) {
      expect(
        loadSessionEntryReadOnly({ sessionKey: `agent:main:bulk-${index}`, storePath }),
      ).toMatchObject({ sessionId: `bulk-${index}-live` });
    }
    // Planner estimates can remain stale after history-only deletion; its entry
    // count did not change and transcript readers use session-scoped indexes.
    expect(windowStatistics()).toEqual({ stat: expect.stringMatching(/^130\b/u) });
  });

  it("pages past protected archives to evict cap-created sessions under pressure", async () => {
    const capKey = "agent:main:explicit:cap-archived";
    const manualKey = "agent:main:explicit:manual-archived";
    const legacyKey = "agent:main:explicit:legacy-archived";
    await entry(capKey, {
      sessionId: "cap-archived",
      updatedAt: 1,
      archivedAt: 1,
      archiveReason: "active-session-cap",
    });
    await append(capKey, "cap-archived", "cap archive " + "x".repeat(64 * 1024));
    await entry(manualKey, {
      sessionId: "manual-archived",
      updatedAt: 2,
      archivedAt: 2,
      archiveReason: "manual",
    });
    await append(manualKey, "manual-archived", "manual archive " + "y".repeat(64 * 1024));
    await entry(legacyKey, { sessionId: "legacy-archived", updatedAt: 3, archivedAt: 3 });
    for (let index = 0; index < 70; index += 1) {
      await entry(`agent:main:explicit:legacy-${index}`, {
        sessionId: `legacy-${index}`,
        updatedAt: index + 4,
        archivedAt: index + 4,
      });
    }
    await entry(capKey, {
      sessionId: "cap-archived",
      updatedAt: 100,
      archivedAt: 100,
      archiveReason: "active-session-cap",
      skillsSnapshot: { prompt: "retained archived instructions", skills: [] },
    });
    settlePhysicalUsage();
    const before = await measureSessionPhysicalDiskUsage(storePath);
    const maintenance = { maxDiskBytes: before.totalBytes - 1, highWaterBytes: 1 };
    const execute = sqliteQueries.executeSqliteQuerySync;
    vi.spyOn(sqliteQueries, "executeSqliteQuerySync").mockImplementation((db, query) => {
      if (query.compile().sql.includes('order by "archived_at" asc')) {
        throw new Error("Archived eviction scan ran on the calling thread");
      }
      return execute(db, query);
    });

    await expect(
      inspectSqliteSessionHistoryDiskBudget({ storePath, mode: "enforce", maintenance }),
    ).resolves.toMatchObject({ wouldMutate: true });
    const result = await enforceSqliteSessionHistoryDiskBudget({ ...budget(), maintenance });

    expect(result?.removedEntries).toBe(1);
    expectSessions({
      "cap-archived": false,
      "manual-archived": true,
      "legacy-archived": true,
      "legacy-69": true,
    });
    expect(readArchiveNames("cap-archived")).toHaveLength(0);
  });

  it("remeasures incompressible archive publication before declaring high water", async () => {
    await seed("incompressible", randomBytes(192 * 1024).toString("base64"));
    settlePhysicalUsage();
    const before = await measureSessionPhysicalDiskUsage(storePath);
    const highWaterBytes = before.totalBytes - 1;

    const result = await enforce(highWaterBytes);
    const actualAfter = await measureSessionPhysicalDiskUsage(storePath);

    expect(result?.removedEntries).toBe(1);
    expect(result?.totalBytesAfter).toBe(actualAfter.totalBytes);
    expect(actualAfter.totalBytes).toBeLessThanOrEqual(highWaterBytes);
    expect(sessionExists("incompressible-old")).toBe(false);
  });

  it.each([
    ["deleted transcript archive", "already-extracted.jsonl.deleted.2026-01-01T00-00-00.000Z"],
    [
      "legacy compact backup",
      `legacy-compact.jsonl.bak.2026-01-01T00-00-00.000Z.${"a".repeat(32)}.zst`,
    ],
  ])("removes a %s before evicting searchable history", async (_kind, archiveName) => {
    await seed("archive", "keep searchable history");
    database().walMaintenance.checkpoint();
    const oldArchive = path.join(tempDir, archiveName);
    fs.writeFileSync(oldArchive, Buffer.alloc(256 * 1024));
    const before = await measureSessionPhysicalDiskUsage(storePath);
    const readReferences = vi.spyOn(sessionLifecycleState, "readReferencedSessionIds");

    const result = await enforceSqliteSessionHistoryDiskBudget({
      env: { OPENCLAW_STATE_DIR: testState.stateDir },
      ...budget(before.totalBytes - 1, before.totalBytes - 64 * 1024),
    });

    expect(result).toMatchObject({ removedEntries: 0, removedFiles: 1 });
    expect(fs.existsSync(oldArchive)).toBe(false);
    expect(sessionExists("archive-old")).toBe(true);
    expect(readReferences.mock.calls.length).toBe(0);
  });

  it("prunes the canonical archive row and its derived file before searchable history", async () => {
    const archivedSessionId = "canonical-archive";
    const archivePath = await archiveSession(archivedSessionId);
    expect(archivePath).toBeTruthy();

    await seed("canonical", "keep searchable history", 2);
    await closeOpenClawAgentDatabaseByPathAsync(database().path);
    settlePhysicalUsage();
    const before = await measureSessionPhysicalDiskUsage(storePath);
    expect(before.databaseWalBytes).toBe(0);
    expect(database().db.prepare("PRAGMA freelist_count").get()).toEqual({ freelist_count: 0 });

    const cachedDatabase = database();
    const rm = fs.promises.rm.bind(fs.promises);
    const removeArchive = vi.spyOn(fs.promises, "rm").mockImplementation(async (...args) => {
      if (args[0] === archivePath) {
        expect(cachedDatabase.db.isOpen).toBe(true);
        closeCachedOpenClawAgentDatabase(cachedDatabase);
        expect(cachedDatabase.db.isOpen).toBe(false);
      }
      return await rm(...args);
    });
    const result = await enforce(before.totalBytes - 1);

    expect(result).toMatchObject({ removedEntries: 0, removedFiles: 1 });
    expect(fs.existsSync(archivePath ?? "")).toBe(false);
    expect(removeArchive).toHaveBeenCalledWith(archivePath);
    expect(
      database()
        .db.prepare("SELECT 1 FROM session_transcript_archives WHERE session_id = ?")
        .get(archivedSessionId),
    ).toBeUndefined();
    expect(sessionExists("canonical-old")).toBe(true);
  });

  it("never prunes an unpublished canonical archive under disk pressure", async () => {
    const sessionId = "pending-pressure";
    const pendingArchivePath = await archiveSession(sessionId, Date.now());
    database()
      .db.prepare("UPDATE session_transcript_archives SET published_at = NULL WHERE session_id = ?")
      .run(sessionId);
    settlePhysicalUsage();
    const before = await measureSessionPhysicalDiskUsage(storePath);

    const result = await enforce(before.totalBytes - 1);

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
    await entry(sessionKey, { sessionId: "admitted-history", updatedAt: 1 });
    await append(sessionKey, "admitted-history", "admitted");
    await reset(sessionKey, "route-history", 2);
    await append(sessionKey, "route-history", "route protected");
    await reset(sessionKey, "trajectory-history", 3);
    appendSqliteTrajectoryRuntimeEvents({ sessionId: "trajectory-history", storePath }, [
      {
        traceSchema: "openclaw-trajectory",
        schemaVersion: 1,
        traceId: "trajectory-history",
        source: "runtime",
        type: "history.test",
        ts: "2026-07-18T00:00:00.000Z",
        seq: 1,
        sessionId: "trajectory-history",
        sessionKey,
      },
    ]);
    await reset(sessionKey, "live-history", Date.now());
    addRouteReference("route-only", "route-history");
    const admission = await beginSessionEffect({
      scope: storePath,
      identities: ["admitted-history"],
      assertAllowed: () => {},
    });
    try {
      const before = await measureSessionPhysicalDiskUsage(storePath);
      const result = await enforce(before.totalBytes - 1, 0);

      expect(result?.removedEntries).toBe(1);
      expect(sessionExists("trajectory-history")).toBe(false);
      // Trajectory-only sessions carry no transcript; eviction reclaims their
      // diagnostic telemetry without writing an empty archive artifact.
      expect(readArchiveNames("trajectory-history")).toHaveLength(0);
      expectSessions({ "admitted-history": true, "route-history": true, "live-history": true });
    } finally {
      admission.release();
    }
  });

  it("preserves a generation admitted by owner key during archive preparation without host lifecycle reads", async () => {
    const sessionKey = "agent:main:admission-during-archive";
    const sessionId = "admission-during-archive-old";
    await seed("admission-during-archive", "history protected while its archive is prepared");
    settlePhysicalUsage();
    const owner = database();
    const archive = await import("./session-accessor.sqlite-archive.js");
    const materialize = archive.materializeSessionHistoryEvictionPlan;
    let admission: Awaited<ReturnType<typeof beginSessionEffect>> | undefined;
    vi.spyOn(archive, "materializeSessionHistoryEvictionPlan").mockImplementationOnce(
      async (input) => {
        const prepared = await materialize(input);
        expect(prepared?.archive?.bytes.byteLength).toBeGreaterThan(0);
        admission = await beginSessionEffect({
          scope: storePath,
          identities: [sessionKey],
          assertAllowed: () => {},
        });
        return prepared;
      },
    );
    const reads = trackSqliteStatementExecutions(
      requireNativeSqliteDatabase(owner.db),
      ["history"],
      (sql) =>
        /^select\b/i.test(sql) &&
        /"(?:session_windows|transcript_rewrite_watermarks|trajectory_runtime_events)"/.test(sql)
          ? "history"
          : null,
    );
    try {
      expect(await enforce()).toMatchObject({ removedEntries: 0 });
      expect(admission).toBeDefined();
      expect(reads.counts.history).toBe(0);
    } finally {
      reads.restore();
      admission?.release();
    }
    expect(sessionExists(sessionId)).toBe(true);
    expectRetainedHistory(sessionId, sessionKey);
  });

  it.each(["archivedAt", "pinnedAt", "age-retention", "manual", "recent"] as const)(
    "rechecks %s on the logical owner before deleting an older generation",
    async (field) => {
      const sessionKey = "agent:main:race";
      const staleAt = Date.now() - 8 * 24 * 60 * 60 * 1000;
      await seed("race", "keep this older generation", staleAt);
      entrySync(sessionKey, {
        sessionId: "race-live",
        updatedAt: staleAt,
        archivedAt: Date.now(),
        archiveReason: "active-session-cap",
      });
      const reclamation = await import("./session-accessor.sqlite-reclamation-run.js");
      const reclaim = reclamation.runSqliteSessionReclamation;
      const historyRequests: string[] = [];
      let protectionChanged = false;
      vi.spyOn(reclamation, "runSqliteSessionReclamation").mockImplementation(async (params) => {
        // Automatic entry planning shares this transport; inject only at the history attempt.
        if (params.plan.kind === "history-eviction") {
          historyRequests.push(params.plan.sessionId);
          if (params.plan.sessionId === "race-old") {
            expect(protectionChanged).toBe(false);
            entrySync(sessionKey, {
              sessionId: "race-live",
              updatedAt: Date.now(),
              ...(field === "age-retention" || field === "manual"
                ? { archivedAt: Date.now(), archiveReason: field }
                : field === "recent"
                  ? {}
                  : { [field]: Date.now() }),
            });
            protectionChanged = true;
          }
        }
        return await reclaim(params);
      });
      expect(
        await enforceSqliteSessionHistoryDiskBudget({
          ...budget(),
          maintenance: {
            ...budget().maintenance,
            ...(field === "recent" ? { preserveRecentMs: 7 * 24 * 60 * 60 * 1000 } : {}),
          },
        }),
      ).toMatchObject({ removedEntries: 0 });
      expect(historyRequests).toEqual(["race-old"]);
      expect(protectionChanged).toBe(true);
      expectRetainedHistory("race-old", sessionKey);
      // An explicit operator delete still owns every generation, even when pinned or archived.
      expect(await remove(sessionKey)).toMatchObject({ deleted: true });
      expect(sessionExists("race-old")).toBe(false);
    },
  );

  it.each([
    { writerKind: "same connection", after: "discovery" },
    { writerKind: "external connection", after: "materialization" },
  ] as const)(
    "rechecks cross-owner references written through a $writerKind after $after",
    async ({ writerKind, after }) => {
      const sessionKey = "agent:main:reference";
      const referringKey = "agent:main:reference-survivor";
      await seed("reference", "retain cross-owner history", Date.now());
      const archive = await import("./session-accessor.sqlite-archive.js");
      const materialize = archive.materializeSessionHistoryEvictionPlan;
      const addReference = () => {
        const owner = database();
        const writer =
          writerKind === "external connection" ? new DatabaseSync(owner.path) : owner.db;
        try {
          const entryJson = JSON.stringify({
            sessionId: "survivor-current",
            updatedAt: 1,
            usageFamilySessionIds: ["reference-old"],
          });
          const columns = deriveSessionPredicateColumns(entryJson);
          writer
            .prepare(
              `INSERT INTO session_nodes (session_key, current_session_id, entry_json, updated_at,
                session_started_at, has_optional_references) VALUES (?, ?, ?, 1, ?, ?)`,
            )
            .run(
              referringKey,
              "survivor-current",
              entryJson,
              columns.session_started_at,
              columns.has_optional_references,
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
        observeDiscovery(addReference);
      }
      const materialization = vi
        .spyOn(archive, "materializeSessionHistoryEvictionPlan")
        .mockImplementationOnce(async (plan) => {
          const prepared = await materialize(plan);
          if (after === "materialization") {
            addReference();
          }
          return prepared;
        });
      expect(await enforce()).toMatchObject({ removedEntries: 0 });
      expect(materialization).toHaveBeenCalledOnce();
      expectRetainedHistory("reference-old", sessionKey);
      // Excluding the deliberately deleted owner must not exclude a surviving reference.
      expect(await remove(sessionKey)).toMatchObject({ deleted: true });
      expect(sessionExists("reference-old")).toBe(true);
      expect(readTranscript("reference-old", referringKey)).not.toEqual([]);
    },
  );

  it("backs off protected over-budget history and warns once while manual cleanup remains immediate", async () => {
    await seed("protected");
    addRouteReference("agent:main:shared-history", "protected-old");
    const settle = async () => {
      await enforceSqliteSessionHistoryDiskBudget({
        ...budget(1, 1, "warn"),
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
    const pruning = vi.spyOn(archivePruning, "pruneAllSessionTranscriptArchivesToHighWater");
    observeDiscovery(references, true);
    const maintenanceConfig = defaultMaintenance();
    const kick = () =>
      kickSessionHistoryDiskBudgetMaintenance({ storePath, force: true, maintenanceConfig });
    const manualSweep = () =>
      enforceSqliteSessionHistoryDiskBudget({ ...budget(), maintenance: maintenanceConfig });
    await expect(manualSweep()).resolves.toMatchObject({ overBudget: true, removedEntries: 0 });
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

    await expect(manualSweep()).resolves.toMatchObject({ overBudget: true, removedEntries: 0 });
    const manualScans = references.mock.calls.length;
    expect(manualScans).toBeGreaterThan(firstScans);
    const manualPruning = pruning.mock.calls.length;

    clock.mockReturnValue(now + 31 * 60_000);
    kick();
    await settle();
    expect(references.mock.calls.length).toBeGreaterThan(manualScans);
    expect(pruning).toHaveBeenCalledTimes(manualPruning);
    expect(evictionWarnSpy).toHaveBeenCalledOnce();
    expectSessions({ "protected-old": true, "protected-live": true });
  });

  it("warns when a fire-and-forget budget sweep fails instead of swallowing it", async () => {
    evictionWarnSpy.mockClear();
    vi.spyOn(diskBudgetModule, "measureSessionPhysicalDiskUsage").mockRejectedValueOnce(
      new Error("sweep exploded"),
    );
    const maintenanceConfig = defaultMaintenance();
    kickSessionHistoryDiskBudgetMaintenance({ storePath, force: true, maintenanceConfig });
    await vi.waitFor(() => {
      expect(evictionWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining("disk-budget sweep failed"),
        expect.objectContaining({ storePath }),
      );
    });
  });

  it("finishes a budget sweep kicked inside a turn after that turn is stopped", async () => {
    // Entry writes kick the store-wide sweep from inside turns; stopping the turn must not
    // cancel the sweep's eviction mutation through the turn's controller context.
    await createHistoricalTranscript({
      content: "kicked " + "x".repeat(64 * 1024),
      nextSessionId: "kicked-live",
      sessionId: "kicked-old",
      sessionKey: "agent:main:kicked-history",
      updatedAt: 10,
    });
    settlePhysicalUsage();
    const before = await measureSessionPhysicalDiskUsage(storePath);
    const maintenanceConfig = resolveMaintenanceConfigFromInput({
      mode: "enforce",
      maxDiskBytes: before.totalBytes - 1,
      highWaterBytes: before.totalBytes - 1,
    });
    evictionWarnSpy.mockClear();
    const stop = new AbortController();
    await withSessionTurn(
      {
        storePath,
        sessionKey: "agent:main:kicking-turn",
        sessionId: "kicking-turn-session",
        abortSignal: stop.signal,
      },
      async () => {
        kickSessionHistoryDiskBudgetMaintenance({ storePath, force: true, maintenanceConfig });
        stop.abort(new Error("turn stopped"));
      },
    );
    await enforceSqliteSessionHistoryDiskBudget({
      storePath,
      mode: "warn",
      maintenance: { maxDiskBytes: null, highWaterBytes: null },
    });

    expect(evictionWarnSpy).not.toHaveBeenCalledWith(
      expect.stringContaining("disk-budget sweep failed"),
      expect.anything(),
    );
    expect(sessionExists("kicked-old")).toBe(false);
    expect(readArchiveNames("kicked-old")).toHaveLength(1);
  });

  it("inspects history after the archive probe loses its cached handle", async () => {
    await seed("inspect", "inspect retained history");
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

    await expect(inspectSqliteSessionHistoryDiskBudget(budget(1, 0))).resolves.toMatchObject({
      wouldMutate: true,
    });
    expect(probeSpy).toHaveBeenCalledOnce();
    expect(sessionExists("inspect-old")).toBe(true);
  });

  it("warn mode reports physical overage without extracting or deleting history", async () => {
    await seed("warn");
    const before = await measureSessionPhysicalDiskUsage(storePath);

    const input = budget(before.totalBytes - 1, 0, "warn");
    const inspected = await inspectSqliteSessionHistoryDiskBudget(input);
    const result = await enforceSqliteSessionHistoryDiskBudget(input);

    expect(inspected).toMatchObject({
      diskBudget: { totalBytesBefore: before.totalBytes },
      wouldMutate: false,
    });
    expect(result).toMatchObject({ overBudget: true, removedEntries: 0, removedFiles: 0 });
    expect(sessionExists("warn-old")).toBe(true);
    expect(readArchiveNames("warn-old")).toHaveLength(0);
  });
});
