import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import type { Worker } from "node:worker_threads";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { BACKGROUND_RESULT_PLACEMENT_CUSTOM_TYPE } from "../../../packages/agent-core/src/harness/session/background-result-placement.js";
import { createDeferred, withTestTimeout } from "../../../test/helpers/promise.js";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { createTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { SessionManager } from "../../agents/sessions/session-manager.js";
import { makeAgentAssistantMessage } from "../../agents/test-helpers/agent-message-fixtures.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import { openNodeSqliteDatabase } from "../../infra/node-sqlite.js";
import { revokeSqliteDatabaseAdmissionsForPath } from "../../infra/sqlite-database-admission.js";
import { getTrackedWorkerLifecycleSnapshot } from "../../infra/worker-cpu.js";
import { flushLogger, setLoggerOverride } from "../../logging/logger.js";
import { beginSessionEffect } from "../../sessions/session-controller.lifecycle.js";
import { sessionChanges } from "../../sessions/session-row-changes.js";
import type { DB } from "../../state/openclaw-agent-db.generated.js";
import {
  closeOpenClawAgentDatabaseByPath,
  closeOpenClawAgentDatabaseByPathAsync,
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
  getOpenClawAgentDatabaseIfOpen,
  openOpenClawAgentDatabase,
  OPENCLAW_AGENT_SCHEMA_VERSION,
  runOpenClawAgentWriteTransaction,
  type OpenClawAgentDatabaseOptions,
} from "../../state/openclaw-agent-db.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseByPathAsync,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { formatSessionArchiveTimestamp } from "./artifacts.js";
import { replaceSessionEntry, replaceSessionEntrySync } from "./session-accessor.js";
import * as archiveWorkers from "./session-accessor.sqlite-archive.js";
import type { SqliteSessionReclamationDiagnostics } from "./session-accessor.sqlite-contract.js";
import { planSessionStateDeleteIfUnreferenced } from "./session-accessor.sqlite-delete-snapshot.js";
import { readSessionTranscriptHistoryEvents } from "./session-accessor.sqlite-history.test-support.js";
import { deleteMaterializedSessionStatePlans } from "./session-accessor.sqlite-lifecycle-state.js";
import {
  loadTranscriptEventsSync,
  loadTranscriptHeaderSync,
  readTranscriptStatsSync,
} from "./session-accessor.sqlite-read.js";
import { resolveSqliteTranscriptArchiveDirectory } from "./session-accessor.sqlite-scope.js";
import { readTranscriptContextVersionInTransaction } from "./session-accessor.sqlite-transcript-state.js";
import { appendTranscriptEventsInTransaction } from "./session-accessor.sqlite-transcript-store.js";
import {
  appendTranscriptEvent,
  appendTranscriptMessage,
} from "./session-accessor.sqlite-transcript-write.js";
import { replaceTranscriptEvents } from "./session-accessor.sqlite-transcript-write.test-support.js";
import { resolveSessionColdArchivePath } from "./session-cold-storage-codec.js";
import {
  assertSessionTranscriptHot,
  readSessionColdTranscript,
} from "./session-cold-storage-state.js";
import { getSessionColdStorageStatus } from "./session-cold-storage-status.js";
import {
  restoreSessionColdTranscript,
  runSessionColdStorageMaintenance,
} from "./session-cold-storage.js";
import {
  createSessionColdStorageFixture,
  currentId,
  historicalId,
  maintenanceConfig,
} from "./session-cold-storage.test-support.js";
import { loadSessionTranscriptEvents as loadTranscriptEvents } from "./session-transcript-events.js";
import { prepareSessionTranscriptHydration } from "./session-transcript-hydration.js";
import { waitForSessionTranscriptIndexReconcile } from "./session-transcript-reconcile.js";
import { prepareTranscriptPayload, transcriptEventJsonSql } from "./transcript-payload.js";

const tempDirs = createTempDirTracker();
const databasePaths: string[] = [];
const sharedDatabasePath = resolveOpenClawStateSqlitePath();

afterEach(async () => {
  vi.restoreAllMocks();
  for (const databasePath of databasePaths.splice(0)) {
    await waitForSessionTranscriptIndexReconcile({ agentId: "main", path: databasePath });
  }
  await closeOpenClawAgentDatabasesAsync();
  await closeOpenClawStateDatabaseByPathAsync(sharedDatabasePath);
  closeOpenClawAgentDatabasesForTest();
  tempDirs.cleanup();
});

afterAll(async () => {
  await closeOpenClawAgentDatabasesAsync();
  await closeOpenClawStateDatabaseAsync();
});

async function createFixture() {
  const root = tempDirs.make("openclaw-cold-roundtrip-");
  const storePath = path.join(root, "agents", "main", "agent", "openclaw-agent.sqlite");
  databasePaths.push(storePath);
  return createSessionColdStorageFixture(storePath);
}

type Fixture = Awaited<ReturnType<typeof createFixture>>;

function customEvent(id: string, customType: string, data: Record<string, unknown> = {}) {
  return { type: "custom", id, customType, data };
}

function maintain(fixture: Fixture, enabled = true, afterDays = 30) {
  return runSessionColdStorageMaintenance({
    config: maintenanceConfig(fixture.scope.storePath, enabled, afterDays),
  });
}

function expectCounts(
  result: ReturnType<typeof runSessionColdStorageMaintenance>,
  archivedTranscripts = 1,
  externalizedTranscripts = 0,
) {
  return expect(result).resolves.toEqual({ archivedTranscripts, externalizedTranscripts });
}

function rows(fixture: Fixture, sql: string, ...params: string[]) {
  return fixture
    .database()
    .prepare(sql)
    .all(...params);
}

async function retireOwner(fixture: Fixture) {
  await closeOpenClawAgentDatabaseByPathAsync(fixture.options.path);
  closeOpenClawAgentDatabasesForTest();
  revokeSqliteDatabaseAdmissionsForPath(fixture.options.path);
}

function setTranscriptActivity(
  options: OpenClawAgentDatabaseOptions,
  sessionId: string,
  updatedAt = 1,
) {
  runOpenClawAgentWriteTransaction(({ db }) => {
    executeSqliteQuerySync(
      db,
      getNodeSqliteKysely<DB>(db)
        .updateTable("session_windows")
        .set({ updated_at: updatedAt, transcript_updated_at: updatedAt })
        .where("session_id", "=", sessionId),
    );
  }, options);
}

function transcriptRows(fixture: Fixture, sessionId: string) {
  return rows(
    fixture,
    "SELECT * FROM transcript_events WHERE session_id = ? ORDER BY seq",
    sessionId,
  );
}

async function fileHash(pathname: string) {
  return createHash("sha256")
    .update(await fs.readFile(pathname))
    .digest("hex");
}

async function archiveFixture(fixture: Fixture) {
  await expectCounts(maintain(fixture));
  const descriptor = readSessionColdTranscript(fixture.database(), historicalId);
  if (!descriptor) {
    throw new Error("Successful archival did not retain its descriptor");
  }
  for (const table of [
    "transcript_events",
    "transcript_event_identities",
    "session_transcript_active_events",
  ]) {
    expect(
      rows(fixture, `SELECT * FROM ${table} WHERE session_id = ?`, historicalId),
      table,
    ).not.toHaveLength(0);
  }
  const archivePath = resolveSessionColdArchivePath(
    fixture.scope.storePath,
    descriptor.archive_name,
  );
  const bytes = await fs.readFile(archivePath);
  expect(bytes.length).toBe(descriptor.archive_bytes);
  return { descriptor, archivePath, bytes };
}

async function createBatchFixture() {
  const fixture = await createFixture();
  const secondScope = {
    ...fixture.scope,
    sessionKey: "agent:main:second-inactive-session",
    sessionId: "second-inactive-current",
  };
  // Fixture seeding must not schedule unrelated age-retention work.
  replaceSessionEntrySync(secondScope, { sessionId: secondScope.sessionId, updatedAt: 1 });
  await replaceTranscriptEvents(secondScope, [
    { type: "session", id: secondScope.sessionId },
    customEvent("second-original", "retained", { text: "Second transcript" }),
  ]);
  await waitForSessionTranscriptIndexReconcile(fixture.options);
  replaceSessionEntrySync(secondScope, { sessionId: secondScope.sessionId, updatedAt: 1 });
  setTranscriptActivity(fixture.options, secondScope.sessionId, 2);
  return {
    ...fixture,
    secondScope,
    original: fixture.snapshot(),
    config: maintenanceConfig(fixture.scope.storePath),
  };
}

async function embedFixtureArchive(fixture: Fixture) {
  const archived = await archiveFixture(fixture);
  runOpenClawAgentWriteTransaction(({ db: database }) => {
    executeSqliteQuerySync(
      database,
      getNodeSqliteKysely<DB>(database)
        .updateTable("session_transcript_cold_archives")
        .set({ storage: "sqlite", archive_blob: archived.bytes })
        .where("session_id", "=", historicalId),
    );
  }, fixture.options);
  await fs.unlink(archived.archivePath);
  return archived;
}

describe("cold transcript storage workers", () => {
  it("reuses cold restoration execution after closing each database lease and preserves every transcript", async () => {
    const fixture = await createBatchFixture();
    const storePath = fixture.scope.storePath;
    const sibling = fixture.secondScope;
    const siblingEvents = loadTranscriptEventsSync(sibling);
    await expectCounts(maintain(fixture), 2);
    const archiveStarts = () =>
      getTrackedWorkerLifecycleSnapshot().workerLifecycle.find(
        ({ script }) => script === "session-accessor.sqlite-archive.worker.js",
      )?.started ?? 0;
    const leases = () =>
      openOpenClawStateDatabase()
        .db.prepare("SELECT lease_id FROM agent_database_leases WHERE path = ? ORDER BY lease_id")
        .all(storePath);
    const baselineLeases = leases();
    const before = archiveStarts();
    expect(before).toBeGreaterThan(0);
    for (let sweep = 0; sweep < 3; sweep++) {
      await expectCounts(maintain(fixture), 0);
    }
    expect(archiveStarts()).toBe(before);
    await restoreSessionColdTranscript(fixture.scope);
    const first = await loadTranscriptEvents(fixture.scope);
    expect(first).toHaveLength(3);
    expect(leases()).toEqual(baselineLeases);
    await restoreSessionColdTranscript(sibling);
    expect(await loadTranscriptEvents(sibling)).toEqual(siblingEvents);
    expect(leases()).toEqual(baselineLeases);
    expect(fixture.snapshot()).toEqual(fixture.original);
    expect(archiveStarts()).toBe(before);
    expect(await loadTranscriptEvents(sibling)).toEqual(siblingEvents);
    expect(archiveStarts()).toBe(before);
    expect(leases()).toEqual(baselineLeases);
  });

  it.each([
    ["enforce", "1h", true],
    ["warn", "1h", false],
    ["enforce", false, false],
  ] as const)(
    "expires archives without cron or cold storage (mode=%s, retention=%s)",
    async (mode, retention, expires) => {
      const fixture = await createFixture();
      const now = Date.parse("2026-10-01T00:00:00.000Z");
      vi.spyOn(Date, "now").mockReturnValue(now);
      replaceSessionEntrySync(fixture.scope, {
        sessionId: currentId,
        previousSessionId: historicalId,
        updatedAt: now,
      });
      const expiredAt = now - 2 * 60 * 60 * 1000;
      const directory = resolveSqliteTranscriptArchiveDirectory(fixture.options);
      await fs.mkdir(directory, { recursive: true });
      const archives = [
        ["expired-delete", "deleted", expiredAt, expiredAt],
        ["expired-reset", "reset", expiredAt, expiredAt],
        ["fresh", "deleted", now, now],
        [historicalId, "reset", expiredAt, expiredAt],
        ["pending", "reset", expiredAt, null],
      ] as const;
      const names = new Map<string, string>();
      for (const [sessionId, reason, createdAt, publishedAt] of archives) {
        const name = `${sessionId}.jsonl.${reason}.${formatSessionArchiveTimestamp(createdAt)}`;
        names.set(sessionId, name);
        await fs.writeFile(path.join(directory, name), "archive");
        fixture
          .database()
          .prepare(`INSERT INTO session_transcript_archives (
            session_id, session_key, generation, archive_name, archive_sha256,
            encoding, reason, created_at, published_at, archive_blob
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(
            sessionId,
            `agent:main:${sessionId}`,
            "retention-generation",
            name,
            createHash("sha256").update("archive").digest("hex"),
            "identity",
            reason,
            createdAt,
            publishedAt,
            Buffer.from("archive"),
          );
      }
      const legacyName = `legacy.jsonl.deleted.${formatSessionArchiveTimestamp(expiredAt)}`;
      await fs.writeFile(path.join(directory, legacyName), "legacy archive");

      await runSessionColdStorageMaintenance({
        config: {
          agents: { entries: { main: {} } },
          cron: { enabled: false },
          session: {
            store: fixture.scope.storePath,
            maintenance: {
              mode,
              resetArchiveRetention: retention,
              maxDiskBytes: false,
              coldStorage: { enabled: false },
            },
          },
        },
      });

      const expected = expires
        ? ["fresh", historicalId, "pending"]
        : ["expired-delete", "expired-reset", "fresh", historicalId, "pending"];
      expect(
        rows(fixture, "SELECT session_id FROM session_transcript_archives ORDER BY session_id"),
      ).toEqual(expected.toSorted().map((session_id) => ({ session_id })));
      const files = await fs.readdir(directory);
      for (const [id, name] of names) {
        expect(files.includes(name), id).toBe(expected.includes(id));
      }
      expect(files.includes(legacyName)).toBe(!expires);
    },
  );

  it("bounds aggregate archive bytes per pass and continues with the remaining large transcript", async () => {
    const root = tempDirs.make("openclaw-cold-byte-budget-");
    const storePath = path.join(root, "agents", "main", "agent", "openclaw-agent.sqlite");
    const options = { agentId: "main", path: storePath };
    databasePaths.push(storePath);
    const sessionIds = ["large-inactive-a", "large-inactive-b"];
    const originalHashes = new Map<string, string>();
    const transcriptHash = (sessionId: string) => {
      const database = openOpenClawAgentDatabase(options).db;
      const hash = createHash("sha256");
      for (const row of executeSqliteQuerySync(
        database,
        getNodeSqliteKysely<DB>(database)
          .selectFrom("transcript_events")
          .select(transcriptEventJsonSql(database).as("event_json"))
          .where("session_id", "=", sessionId)
          .orderBy("seq"),
      ).rows) {
        hash.update(row.event_json);
        hash.update("\n");
      }
      return hash.digest("hex");
    };
    for (const sessionId of sessionIds) {
      const scope = {
        agentId: "main",
        storePath,
        sessionId,
        sessionKey: `agent:main:${sessionId}`,
      };
      await replaceSessionEntry(scope, { sessionId, updatedAt: 1 });
      await replaceTranscriptEvents(scope, [
        customEvent(`${sessionId}-event`, "large-artifact", { text: "x".repeat(34 * 1024 * 1024) }),
      ]);
      await waitForSessionTranscriptIndexReconcile(options);
      await replaceSessionEntry(scope, { sessionId, updatedAt: 1 });
      setTranscriptActivity(options, sessionId);
      originalHashes.set(sessionId, transcriptHash(sessionId));
    }
    const config = maintenanceConfig(storePath);
    await expectCounts(runSessionColdStorageMaintenance({ config }));
    const database = openOpenClawAgentDatabase(options).db;
    const remaining = executeSqliteQuerySync(
      database,
      getNodeSqliteKysely<DB>(database)
        .selectFrom("transcript_events")
        .select("session_id")
        .where((eb) =>
          eb.not(
            eb.exists(
              eb
                .selectFrom("session_transcript_cold_archives")
                .select("session_id")
                .whereRef(
                  "session_transcript_cold_archives.session_id",
                  "=",
                  "transcript_events.session_id",
                ),
            ),
          ),
        )
        .distinct(),
    ).rows;
    expect(remaining).toHaveLength(1);
    const remainingId = remaining[0]!.session_id;
    expect(transcriptHash(remainingId)).toBe(originalHashes.get(remainingId));
    expect(
      database.prepare("SELECT COUNT(*) AS count FROM session_transcript_cold_archives").get(),
    ).toEqual({ count: 1 });
    await expectCounts(runSessionColdStorageMaintenance({ config }));
    expect(
      database
        .prepare(`SELECT COUNT(*) AS count FROM transcript_events
      WHERE session_id NOT IN (SELECT session_id FROM session_transcript_cold_archives)`)
        .get(),
    ).toEqual({
      count: 0,
    });
    expect(
      database.prepare("SELECT COUNT(*) AS count FROM session_transcript_cold_archives").get(),
    ).toEqual({ count: 2 });
  });

  it("inspects an idle consolidated database without acquiring a writable store", async () => {
    const fixture = await createFixture();
    await replaceSessionEntry(fixture.scope, { sessionId: currentId, updatedAt: Date.now() });
    runOpenClawAgentWriteTransaction(({ db }) => {
      executeSqliteQuerySync(
        db,
        getNodeSqliteKysely<DB>(db)
          .updateTable("session_windows")
          .set({ updated_at: Date.now(), transcript_updated_at: Date.now() }),
      );
    }, fixture.options);
    fixture.database().exec("VACUUM;");
    expect(fixture.database().prepare("PRAGMA freelist_count").get()).toEqual({
      freelist_count: 0,
    });
    await closeOpenClawAgentDatabaseByPathAsync(fixture.options.path);
    closeOpenClawAgentDatabasesForTest();
    const pathname = fixture.scope.storePath;
    await fs.chmod(pathname, 0o400);
    const originalMode = (await fs.stat(pathname)).mode;
    const originalHash = await fileHash(pathname);
    try {
      await expectCounts(maintain(fixture), 0);
      expect((await fs.stat(pathname)).mode).toBe(originalMode);
      expect(await fileHash(pathname)).toBe(originalHash);
      expect(getOpenClawAgentDatabaseIfOpen(fixture.options)).toBeUndefined();
    } finally {
      await fs.chmod(pathname, 0o600);
    }
  });

  it("archives several inactive sessions in one maintenance pass and restores both exactly", async () => {
    const fixture = await createBatchFixture();
    await closeOpenClawAgentDatabaseByPathAsync(fixture.options.path);
    const file = path.join(path.dirname(fixture.scope.storePath), "cold-storage.log");
    await fs.writeFile(file, "");
    setLoggerOverride({ level: "info", consoleLevel: "silent", file });
    let clock = 0;
    vi.spyOn(performance, "now").mockImplementation(() => clock);
    const originalWorker = archiveWorkers.runSqliteTranscriptArchiveWorkerOperation;
    const archiveDiagnostics: SqliteSessionReclamationDiagnostics[] = [];
    vi.spyOn(archiveWorkers, "runSqliteTranscriptArchiveWorkerOperation").mockImplementation(
      (params) => {
        if (params.expectedMessageType !== "reclaimed") {
          return originalWorker(params);
        }
        if (params.diagnostics) {
          archiveDiagnostics.push(params.diagnostics);
        }
        const withWriteAdmission = params.withWriteAdmission;
        let admissions = 0;
        return originalWorker({
          ...params,
          withWriteAdmission: async (...args) => {
            // Measure time waiting for actual Worker admission without delaying native work.
            if (++admissions === 1) {
              clock += 1_500;
            }
            return withWriteAdmission(...args);
          },
        });
      },
    );
    const workers = new Map<number, Worker>();
    const observeWorker = (worker: Worker) => workers.set(worker.threadId, worker);
    process.on("worker", observeWorker);
    try {
      closeOpenClawAgentDatabasesForTest();
      revokeSqliteDatabaseAdmissionsForPath(fixture.options.path);
      await expectCounts(runSessionColdStorageMaintenance({ config: fixture.config }), 2);
      await retireOwner(fixture);
      await restoreSessionColdTranscript(fixture.scope);
      await retireOwner(fixture);
      await restoreSessionColdTranscript(fixture.secondScope);
      expect(fixture.snapshot()).toEqual(fixture.original);
      await closeOpenClawAgentDatabaseByPathAsync(fixture.options.path);
      await flushLogger();
      const summaries = (await fs.readFile(file, "utf8"))
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .filter((record) => record.message === "slow SQLite reclamation Worker operation")
        .map((record) => record["1"]);
      expect(summaries).toMatchObject(
        ["cold-batch", "cold-restore", "cold-restore"].map((reclamationKind) => ({
          reclamationKind,
          elapsedMs: 1_500,
          outcome: "resolved",
        })),
      );
      expect(archiveDiagnostics).toHaveLength(3);
      for (const diagnostics of archiveDiagnostics) {
        expect(workers.get(diagnostics.workerThreadId!)?.threadId).toBe(-1);
      }
    } finally {
      process.off("worker", observeWorker);
      vi.restoreAllMocks();
      await flushLogger();
      setLoggerOverride(null);
    }
  });

  it("preserves embedded archives while disabled or damaged and externalizes after repair", async () => {
    const fixture = await createFixture();
    const { descriptor, archivePath, bytes } = await embedFixtureArchive(fixture);
    const before = fixture.snapshot();
    const embedded = rows(fixture, "SELECT * FROM session_transcript_cold_archives");
    await expectCounts(maintain(fixture, false), 0);
    expect(fixture.snapshot()).toEqual(before);
    expect(rows(fixture, "SELECT * FROM session_transcript_cold_archives")).toEqual(embedded);
    await expect(fs.access(archivePath)).rejects.toMatchObject({ code: "ENOENT" });
    await fs.writeFile(archivePath, Buffer.alloc(bytes.length));
    await expect(maintain(fixture)).rejects.toThrow(/collision|verification/);
    expect(rows(fixture, "SELECT * FROM session_transcript_cold_archives")).toEqual(embedded);
    expect(fixture.snapshot()).toEqual(before);
    await fs.unlink(archivePath);
    await expectCounts(maintain(fixture), 0, 1);
    expect(fixture.snapshot()).toEqual(before);
    expect(readSessionColdTranscript(fixture.database(), historicalId)).toEqual(descriptor);
    expect(
      fixture.database().prepare("SELECT archive_blob FROM session_transcript_cold_archives").get(),
    ).toEqual({ archive_blob: null });
    expect(await fs.readFile(archivePath)).toEqual(bytes);
  });

  it("lets hot appends finish during batch preparation and skips only the changed candidate", async () => {
    const fixture = await createBatchFixture();
    const entered = createDeferred();
    const release = createDeferred();
    const originalWorker = archiveWorkers.prepareSqliteColdArchiveBatch;
    let held = false;
    vi.spyOn(archiveWorkers, "prepareSqliteColdArchiveBatch").mockImplementation(
      async (...args) => {
        const result = await originalWorker(...args);
        if (!held) {
          held = true;
          entered.resolve();
          await release.promise;
        }
        return result;
      },
    );
    const maintenance = runSessionColdStorageMaintenance({ config: fixture.config });
    void maintenance.catch(() => {});
    try {
      await Promise.race([
        entered.promise,
        maintenance.then(() => {
          throw new Error("Maintenance finished without preparing its candidates");
        }),
      ]);
      const before = transcriptRows(fixture, fixture.secondScope.sessionId);
      await withTestTimeout(
        appendTranscriptEvent(fixture.secondScope, customEvent("during-cold-prepare", "activity")),
        5_000,
        "Hot append waited for cold archive preparation",
      );
      const after = transcriptRows(fixture, fixture.secondScope.sessionId);
      expect(after.slice(0, before.length)).toEqual(before);
      expect(after).toHaveLength(before.length + 1);
    } finally {
      release.resolve();
      await maintenance;
    }
    await expectCounts(maintenance);
    expect(readSessionColdTranscript(fixture.database(), historicalId)).toBeDefined();
    expect(
      readSessionColdTranscript(fixture.database(), fixture.secondScope.sessionId),
    ).toBeUndefined();
  });

  it.each(["authority", "database owner"])(
    "rolls back every candidate when maintenance %s is revoked at commit",
    async (revocation) => {
      const fixture = await createBatchFixture();
      await closeOpenClawAgentDatabaseByPathAsync(fixture.options.path);
      fixture.database();
      const originalWorker = archiveWorkers.runSqliteTranscriptArchiveWorkerOperation;
      const archiveDiagnostics: SqliteSessionReclamationDiagnostics[] = [];
      let prepared = false;
      let revoked = false;
      let closeElapsedMs = 0;
      const prepare = archiveWorkers.prepareSqliteColdArchiveBatch;
      vi.spyOn(archiveWorkers, "prepareSqliteColdArchiveBatch").mockImplementation(
        async (...args) => {
          const result = await prepare(...args);
          prepared = true;
          return result;
        },
      );
      vi.spyOn(archiveWorkers, "runSqliteTranscriptArchiveWorkerOperation").mockImplementation(
        async (params) => {
          if (prepared && params.expectedMessageType === "reclaimed") {
            if (params.diagnostics) {
              archiveDiagnostics.push(params.diagnostics);
            }
            return originalWorker({
              ...params,
              onCommitRequest: () => {
                const started = performance.now();
                revoked =
                  revocation === "database owner"
                    ? closeOpenClawAgentDatabaseByPath(fixture.options.path)
                    : true;
                closeElapsedMs = performance.now() - started;
                params.onCommitRequest();
              },
            });
          }
          return originalWorker(params);
        },
      );
      const workers = new Map<number, Worker>();
      const observeWorker = (worker: Worker) => workers.set(worker.threadId, worker);
      process.on("worker", observeWorker);
      try {
        await expect(
          runSessionColdStorageMaintenance({
            config: fixture.config,
            assertCurrent: () => {
              if (revoked && revocation === "authority") {
                throw new Error("Test maintenance authority was revoked");
              }
            },
          }),
        ).rejects.toThrow(
          revocation === "authority"
            ? "Test maintenance authority was revoked"
            : "Agent database execution admission is closed",
        );
        expect(archiveDiagnostics).toHaveLength(1);
        expect(workers.get(archiveDiagnostics[0]!.workerThreadId!)?.threadId).toBe(-1);
      } finally {
        process.off("worker", observeWorker);
      }
      expect(prepared).toBe(true);
      expect(revoked).toBe(true);
      expect(closeElapsedMs).toBeLessThan(2_000);
      if (revocation === "database owner") {
        await closeOpenClawAgentDatabaseByPathAsync(fixture.options.path);
      }
      expect(fixture.snapshot()).toEqual(fixture.original);
      expect(rows(fixture, "SELECT * FROM session_transcript_cold_archives")).toEqual([]);
    },
  );

  it("reaches eligible history after more than one batch of protected old windows", async () => {
    const fixture = await createFixture();
    const protectedIds = Array.from({ length: 129 }, (_, index) => `protected-history-${index}`);
    await replaceSessionEntry(fixture.scope, {
      sessionId: currentId,
      updatedAt: 1,
      usageFamilySessionIds: protectedIds,
    });
    runOpenClawAgentWriteTransaction(({ db: database }) => {
      const db = getNodeSqliteKysely<DB>(database);
      for (const sessionId of protectedIds) {
        executeSqliteQuerySync(
          database,
          db.insertInto("session_windows").values({
            session_id: sessionId,
            session_key: fixture.scope.sessionKey,
            created_at: 0,
            updated_at: 0,
            transcript_updated_at: 0,
          }),
        );
        executeSqliteQuerySync(
          database,
          db.insertInto("transcript_events").values({
            session_id: sessionId,
            seq: 0,
            ...prepareTranscriptPayload(
              database,
              JSON.stringify({ type: "session", id: sessionId }),
            ),
            created_at: 0,
          }),
        );
        executeSqliteQuerySync(
          database,
          db.insertInto("transcript_rewrite_watermarks").values({
            session_id: sessionId,
            generation: `generation-${sessionId}`,
            updated_at: 0,
          }),
        );
      }
    }, fixture.options);
    await expectCounts(maintain(fixture));
    expect(readSessionColdTranscript(fixture.database(), historicalId)).toBeDefined();
    for (const sessionId of protectedIds) {
      expect(readSessionColdTranscript(fixture.database(), sessionId)).toBeUndefined();
      expect(
        fixture
          .database()
          .prepare("SELECT COUNT(*) AS count FROM transcript_events WHERE session_id = ?")
          .get(sessionId),
      ).toEqual({ count: 1 });
    }
  });

  it("retains background-result placement navigation and restores model order without rewriting accepted bytes", async () => {
    const fixture = await createFixture();
    const result = makeAgentAssistantMessage({
      provider: "openclaw",
      model: "automation-result",
      content: [{ type: "text", text: "Accepted background result" }],
    });
    const answer = makeAgentAssistantMessage({
      content: [{ type: "text", text: "Foreground answer" }],
    });
    await appendTranscriptMessage(fixture.scope, {
      eventId: "result",
      parentId: "history-assistant",
      message: { ...result, excludeFromContext: true, openclawModelPlacement: "pending" },
    });
    await appendTranscriptMessage(fixture.scope, {
      eventId: "answer",
      parentId: "result",
      message: answer,
    });
    await appendTranscriptEvent(fixture.scope, {
      ...customEvent("placement", BACKGROUND_RESULT_PLACEMENT_CUSTOM_TYPE, {
        afterEntryId: "answer",
        resultEntryIds: ["result"],
      }),
      parentId: "answer",
    });
    await waitForSessionTranscriptIndexReconcile(fixture.options);
    setTranscriptActivity(fixture.options, historicalId);
    const canonical = loadTranscriptEventsSync(fixture.scope);
    const { descriptor } = await archiveFixture(fixture);
    expect(
      rows(
        fixture,
        `SELECT event_json, event_zstd,
          json_extract(navigation_json, '$.model.message.openclawModelPlacement') AS placement,
          json_extract(navigation_json, '$.model.data.afterEntryId') AS after_id,
          json_extract(navigation_json, '$.model.data.resultEntryIds') AS result_ids
         FROM transcript_events WHERE session_id = ?
          AND json_extract(navigation_json, '$.model.id') IN ('result', 'placement') ORDER BY seq`,
        historicalId,
      ),
    ).toEqual([
      {
        event_json: null,
        event_zstd: null,
        placement: "pending",
        after_id: null,
        result_ids: null,
      },
      {
        event_json: null,
        event_zstd: null,
        placement: null,
        after_id: "answer",
        result_ids: '["result"]',
      },
    ]);
    expect(readSessionColdTranscript(fixture.database(), historicalId)).toEqual(descriptor);
    await restoreSessionColdTranscript(fixture.scope);
    const manager = await SessionManager.openModelContextAsync(fixture.scope);
    expect(manager.buildSessionContext().messages.slice(-2)).toEqual([answer, result]);
    expect(readSessionColdTranscript(fixture.database(), historicalId)).toBeUndefined();
    expect(loadTranscriptEventsSync(fixture.scope)).toEqual(canonical);
  });

  it.each(["file", "sqlite", "missing", "corrupt"] as const)(
    "reads cold %s without restoration, then restores exact projections after reopening",
    async (storage) => {
      const fixture = await createFixture();
      const metadata = () => ({
        stats: readTranscriptStatsSync(fixture.scope),
        version: readTranscriptContextVersionInTransaction(
          { db: fixture.database() },
          historicalId,
        ),
      });
      const retainedMetadata = metadata();
      const events = loadTranscriptEventsSync(fixture.scope);
      const hydrated = await prepareSessionTranscriptHydration(fixture.scope).read();
      assertSessionTranscriptHot(fixture.database(), historicalId);
      const deletion = {
        archiveDirectory: path.dirname(fixture.scope.storePath),
        database: openOpenClawAgentDatabase(fixture.options),
        referencedSessionIds: new Set<string>(),
        sessionId: historicalId,
      };
      const hotPlan = planSessionStateDeleteIfUnreferenced({
        ...deletion,
        archiveTranscript: false,
      });
      expect(hotPlan).not.toBeNull();
      const preparedDeletion = await archiveWorkers.materializeSessionStateDeletePlans([hotPlan!]);
      const archived =
        storage === "sqlite" ? await embedFixtureArchive(fixture) : await archiveFixture(fixture);
      const navigation = transcriptRows(fixture, historicalId);
      if (storage === "missing" || storage === "corrupt") {
        if (storage === "missing") {
          await fs.unlink(archived.archivePath);
        } else {
          await fs.writeFile(archived.archivePath, Buffer.alloc(archived.bytes.length));
        }
        await expect(restoreSessionColdTranscript(fixture.scope)).rejects.toThrow(
          storage === "missing" ? /missing or unreadable/ : /failed verification/,
        );
        expect(readSessionColdTranscript(fixture.database(), historicalId)).toEqual(
          archived.descriptor,
        );
        expect(transcriptRows(fixture, historicalId)).toEqual(navigation);
        await fs.writeFile(archived.archivePath, archived.bytes);
      }
      expect(
        runOpenClawAgentWriteTransaction(
          (database) => deleteMaterializedSessionStatePlans(database, preparedDeletion),
          fixture.options,
        ),
      ).toEqual([]);
      expect(metadata()).toEqual(retainedMetadata);
      for (const read of [
        () => assertSessionTranscriptHot(fixture.database(), historicalId),
        () => loadTranscriptEventsSync(fixture.scope),
        () => readSessionTranscriptHistoryEvents(fixture.scope),
        () => loadTranscriptHeaderSync(fixture.scope),
      ]) {
        expect(read).toThrow(expect.objectContaining({ code: "TRANSCRIPT_COLD" }));
      }
      expect(planSessionStateDeleteIfUnreferenced(deletion)).toBeNull();
      const hostSql = observeHostDataSql();
      try {
        await expect(loadTranscriptEvents({ ...fixture.scope, maxEventBytes: 1 })).rejects.toThrow(
          "Trajectory transcript store is too large to export",
        );
        await expect(loadTranscriptEvents(fixture.scope)).resolves.toEqual(events);
        await expect(prepareSessionTranscriptHydration(fixture.scope).read()).resolves.toEqual(
          hydrated,
        );
        expect(hostSql.queries).toEqual([]);
      } finally {
        hostSql.restore();
      }
      expect(readSessionColdTranscript(fixture.database(), historicalId)).toBeDefined();
      expect(transcriptRows(fixture, historicalId)).toEqual(navigation);
      await closeOpenClawAgentDatabaseByPathAsync(fixture.options.path);
      closeOpenClawAgentDatabasesForTest();
      let inspection: ReturnType<typeof openNodeSqliteDatabase> | undefined;
      // The committed notification must not re-register a writable database while observing it.
      const readOnly = () =>
        (inspection ??= openNodeSqliteDatabase(fixture.options.path, { readOnly: true }));
      const changes = vi.fn(() => Boolean(readSessionColdTranscript(readOnly(), historicalId)));
      const unsubscribe = sessionChanges.subscribe(changes);
      try {
        await restoreSessionColdTranscript(fixture.scope);
        expect(fixture.snapshot(readOnly())).toEqual(fixture.original);
        expect(
          readOnly()
            .prepare(`SELECT navigation_type, navigation_custom_type, navigation_display,
              message_role, navigation_last_type, navigation_last_custom_type, navigation_valid
              FROM transcript_events WHERE session_id = ? ORDER BY seq`)
            .all(historicalId),
        ).toEqual(
          [null, "user", "assistant"].map((role) => ({
            navigation_type: role === null ? "session" : "message",
            navigation_custom_type: null,
            navigation_display: 0,
            message_role: role,
            navigation_last_type: role === null ? "session" : "message",
            navigation_last_custom_type: null,
            navigation_valid: 1,
          })),
        );
        expect(
          readOnly()
            .prepare(`SELECT f.message_id FROM session_transcript_fts_rows m
            JOIN session_transcript_fts f ON f.rowid=m.id AND f.session_id=m.session_id
            WHERE m.session_id=? ORDER BY f.message_id`)
            .all(historicalId),
        ).toEqual([{ message_id: "history-assistant" }, { message_id: "history-user" }]);
        expect(readSessionColdTranscript(readOnly(), historicalId)).toBeUndefined();
        expect(readOnly().prepare("PRAGMA quick_check").get()).toEqual({
          quick_check: "ok",
        });
        expect(readOnly().prepare("PRAGMA foreign_key_check").all()).toEqual([]);
        await restoreSessionColdTranscript(fixture.scope);
        expect(fixture.snapshot(readOnly())).toEqual(fixture.original);
        expect(changes).toHaveBeenCalledExactlyOnceWith({
          storePath: fixture.scope.storePath,
          sessionKey: fixture.scope.sessionKey,
          scope: "transcript",
        });
        expect(changes.mock.results[0]?.value).toBe(false);
      } finally {
        unsubscribe();
        inspection?.close();
      }
    },
  );

  it("applies the day cutoff and protects eligible history until its work admission settles", async () => {
    const fixture = await createFixture();
    setTranscriptActivity(fixture.options, historicalId, Date.now() - 15 * 86_400_000);
    const before = fixture.snapshot();
    await expectCounts(maintain(fixture, true, 30), 0);
    expect(fixture.snapshot()).toEqual(before);
    const admission = await beginSessionEffect({
      scope: fixture.scope.storePath,
      identities: [fixture.scope.sessionKey],
      assertAllowed: () => {},
    });
    try {
      await expectCounts(maintain(fixture, true, 7), 0);
      expect(fixture.snapshot()).toEqual(before);
    } finally {
      admission.release();
      await admission.released;
    }
    await expectCounts(maintain(fixture, true, 7));
    expect(readSessionColdTranscript(fixture.database(), historicalId)).toBeDefined();
  });

  it.each([
    { version: 19, expected: /uses schema version 19/ },
    {
      version: OPENCLAW_AGENT_SCHEMA_VERSION,
      expected: expect.objectContaining({
        name: "SessionMetadataUnavailableError",
        reason: "table-missing",
        missingTables: ["session_transcript_cold_archives"],
      }),
    },
  ])(
    "rejects unmigrated or damaged schema $version instead of reporting zero transcripts",
    async ({ version, expected }) => {
      const fixture = await createFixture();
      const db = fixture.database();
      db.exec(`DROP TABLE session_transcript_cold_archives; PRAGMA user_version = ${version};`);
      db.prepare("UPDATE schema_meta SET schema_version = ? WHERE meta_key = 'primary'").run(
        version,
      );
      await closeOpenClawAgentDatabaseByPathAsync(fixture.options.path);
      closeOpenClawAgentDatabasesForTest();
      const before = await fileHash(fixture.scope.storePath);
      await expect(
        getSessionColdStorageStatus(maintenanceConfig(fixture.scope.storePath)),
      ).rejects.toThrow(expected);
      expect(await fileHash(fixture.scope.storePath)).toBe(before);
      expect(getOpenClawAgentDatabaseIfOpen(fixture.options)).toBeUndefined();
    },
  );

  it("archives an inactive current transcript and restores its original bytes before appending", async () => {
    const fixture = await createFixture();
    const scope = { ...fixture.scope, sessionId: currentId };
    setTranscriptActivity(fixture.options, currentId);
    const before = transcriptRows(fixture, currentId);
    await expectCounts(maintain(fixture), 2);
    expect(readSessionColdTranscript(fixture.database(), currentId)).toBeDefined();
    expect(() =>
      runOpenClawAgentWriteTransaction((database) => {
        appendTranscriptEventsInTransaction(database, scope, [
          customEvent("cold-rejected", "rejected"),
        ]);
      }, fixture.options),
    ).toThrow(expect.objectContaining({ code: "TRANSCRIPT_COLD" }));
    await appendTranscriptEvent(scope, customEvent("after-cold-restore", "restored"));
    const after = transcriptRows(fixture, currentId);
    expect(after.slice(0, before.length)).toEqual(before);
    expect(after).toHaveLength(before.length + 1);
    expect(after.map((row) => row.seq)).toEqual(after.map((_, index) => index));
    expect(readSessionColdTranscript(fixture.database(), currentId)).toBeUndefined();
    await replaceSessionEntry(scope, { sessionId: currentId, updatedAt: 1 });
    setTranscriptActivity(fixture.options, currentId);
    const resumed = fixture.snapshot();
    await expectCounts(maintain(fixture), 0);
    expect(fixture.snapshot()).toEqual(resumed);
  });
});
