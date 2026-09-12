import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred, withTestTimeout } from "../../../test/helpers/promise.js";
import { createTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import { beginSessionWorkAdmission } from "../../sessions/session-lifecycle-admission.js";
import type { DB } from "../../state/openclaw-agent-db.generated.js";
import {
  closeOpenClawAgentDatabasesForTest,
  getOpenClawAgentDatabaseIfOpen,
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import { replaceSessionEntry } from "./session-accessor.js";
import * as archiveWorkers from "./session-accessor.sqlite-archive.js";
import { readSessionTranscriptHistoryEvents } from "./session-accessor.sqlite-history-events.js";
import { planSessionStateDeleteIfUnreferenced } from "./session-accessor.sqlite-lifecycle-state.js";
import {
  loadTranscriptEvents,
  loadTranscriptEventsSync,
  loadTranscriptHeaderSync,
  loadTranscriptTailEventsSync,
  readTranscriptStatsSync,
} from "./session-accessor.sqlite-read.js";
import { readTranscriptContextVersionInTransaction } from "./session-accessor.sqlite-transcript-state.js";
import {
  appendTranscriptEvent,
  replaceTranscriptEvents,
} from "./session-accessor.sqlite-transcript-write.js";
import { resolveSessionColdArchivePath } from "./session-cold-storage-codec.js";
import { readSessionColdTranscript } from "./session-cold-storage-state.js";
import {
  getSessionColdStorageStatus,
  restoreSessionColdTranscript,
  runSessionColdStorageMaintenance,
} from "./session-cold-storage.js";
import { waitForSessionTranscriptIndexReconcile } from "./session-transcript-reconcile.js";

const tempDirs = createTempDirTracker();
const databasePaths: string[] = [];
const historicalId = "cold-history-window";
const currentId = "current-window";

afterEach(async () => {
  vi.restoreAllMocks();
  for (const databasePath of databasePaths.splice(0)) {
    await waitForSessionTranscriptIndexReconcile({ agentId: "main", path: databasePath });
  }
  closeOpenClawAgentDatabasesForTest();
  tempDirs.cleanup();
});

async function createFixture() {
  const root = tempDirs.make("openclaw-cold-roundtrip-");
  const storePath = path.join(root, "agents", "main", "agent", "openclaw-agent.sqlite");
  databasePaths.push(storePath);
  const options = { agentId: "main", path: storePath };
  const scope = {
    agentId: "main",
    storePath,
    sessionKey: "agent:main:cold-roundtrip",
    sessionId: historicalId,
  };
  await replaceSessionEntry(scope, { sessionId: historicalId, updatedAt: 1 });
  await replaceTranscriptEvents(scope, [
    { type: "session", id: historicalId },
    {
      type: "message",
      id: "history-user",
      parentId: null,
      timestamp: 10,
      message: { role: "user", content: [{ type: "text", text: "你好 🦞\n".repeat(12_000) }] },
    },
    {
      type: "message",
      id: "history-assistant",
      parentId: "history-user",
      timestamp: 11,
      message: { role: "assistant", content: [{ type: "text", text: "Preserved response" }] },
    },
  ]);
  await waitForSessionTranscriptIndexReconcile(options);
  await replaceSessionEntry(scope, { sessionId: currentId, updatedAt: 1 });
  await replaceTranscriptEvents({ ...scope, sessionId: currentId }, [
    { type: "session", id: currentId, content: "Keep current history hot" },
  ]);
  await waitForSessionTranscriptIndexReconcile(options);
  await replaceSessionEntry(scope, { sessionId: currentId, updatedAt: 1 });
  runOpenClawAgentWriteTransaction(({ db: database }) => {
    const db = getNodeSqliteKysely<DB>(database);
    executeSqliteQuerySync(
      database,
      db.updateTable("session_windows").set({ previous_session_id: null }),
    );
    executeSqliteQuerySync(
      database,
      db
        .updateTable("session_windows")
        .set({ updated_at: 1, transcript_updated_at: 1 })
        .where("session_id", "=", historicalId),
    );
    // Importers preserve raw JSON spacing and identity metadata independently of event payloads.
    executeSqliteQuerySync(
      database,
      db
        .updateTable("transcript_events")
        .set({ event_json: '{ "type" : "session", "id" : "cold-history-window" }', created_at: 7 })
        .where("session_id", "=", historicalId)
        .where("seq", "=", 0),
    );
    executeSqliteQuerySync(
      database,
      db
        .updateTable("transcript_event_identities")
        .set({ message_idempotency_key: "original-idempotency-key", created_at: 8 })
        .where("session_id", "=", historicalId)
        .where("event_id", "=", "history-user"),
    );
  }, options);

  const database = () => openOpenClawAgentDatabase(options).db;
  const snapshot = () => {
    const db = database();
    return {
      events: db.prepare("SELECT * FROM transcript_events ORDER BY session_id, seq").all(),
      identities: db
        .prepare("SELECT * FROM transcript_event_identities ORDER BY session_id, seq, event_id")
        .all(),
      active: db
        .prepare(
          "SELECT * FROM session_transcript_active_events ORDER BY session_id, active_position",
        )
        .all(),
      index: db.prepare("SELECT * FROM session_transcript_index_state ORDER BY session_id").all(),
      search: db
        .prepare(
          "SELECT session_id, message_id, text, role, timestamp FROM session_transcript_fts ORDER BY session_id, message_id",
        )
        .all(),
      generations: db
        .prepare("SELECT * FROM transcript_rewrite_watermarks ORDER BY session_id")
        .all(),
      windows: db.prepare("SELECT * FROM session_windows ORDER BY session_id").all(),
      nodes: db.prepare("SELECT * FROM session_nodes ORDER BY session_key").all(),
    };
  };
  const original = snapshot();
  expect(original.identities).toContainEqual(
    expect.objectContaining({ message_idempotency_key: "original-idempotency-key" }),
  );
  expect(original.active).toContainEqual(expect.objectContaining({ session_id: historicalId }));
  expect(original.search).toContainEqual(
    expect.objectContaining({ message_id: "history-user", timestamp: 10 }),
  );
  return { options, scope, database, snapshot, original };
}

async function archiveFixture(fixture: Awaited<ReturnType<typeof createFixture>>) {
  expect(
    await runSessionColdStorageMaintenance({ config: maintenanceConfig(fixture.scope.storePath) }),
  ).toEqual({ archivedTranscripts: 1, externalizedTranscripts: 0 });
  const descriptor = readSessionColdTranscript(fixture.database(), historicalId);
  if (!descriptor) {
    throw new Error("Successful archival did not retain its descriptor");
  }
  expect(
    fixture
      .database()
      .prepare("SELECT * FROM transcript_events WHERE session_id = ?")
      .all(historicalId),
  ).toEqual([]);
  expect(
    fixture
      .database()
      .prepare("SELECT * FROM transcript_event_identities WHERE session_id = ?")
      .all(historicalId),
  ).toEqual([]);
  expect(
    fixture
      .database()
      .prepare("SELECT * FROM session_transcript_active_events WHERE session_id = ?")
      .all(historicalId),
  ).toEqual([]);
  const archivePath = resolveSessionColdArchivePath(
    fixture.scope.storePath,
    descriptor.archive_name,
  );
  const bytes = await fs.readFile(archivePath);
  expect(bytes.length).toBe(descriptor.archive_bytes);
  return { descriptor, archivePath, bytes };
}

function maintenanceConfig(storePath: string, enabled = true, afterDays = 30) {
  return {
    agents: { list: [{ id: "main" }] },
    session: { store: storePath, maintenance: { coldStorage: { enabled, afterDays } } },
  };
}

async function createBatchFixture() {
  const fixture = await createFixture();
  const secondScope = {
    ...fixture.scope,
    sessionKey: "agent:main:second-inactive-session",
    sessionId: "second-inactive-current",
  };
  await replaceSessionEntry(secondScope, { sessionId: secondScope.sessionId, updatedAt: 1 });
  await replaceTranscriptEvents(secondScope, [
    { type: "session", id: secondScope.sessionId },
    {
      type: "custom",
      id: "second-original",
      customType: "retained",
      data: { text: "Second transcript" },
    },
  ]);
  await waitForSessionTranscriptIndexReconcile(fixture.options);
  await replaceSessionEntry(secondScope, { sessionId: secondScope.sessionId, updatedAt: 1 });
  runOpenClawAgentWriteTransaction(({ db: database }) => {
    executeSqliteQuerySync(
      database,
      getNodeSqliteKysely<DB>(database)
        .updateTable("session_windows")
        .set({ updated_at: 2, transcript_updated_at: 2 })
        .where("session_id", "=", secondScope.sessionId),
    );
  }, fixture.options);
  return {
    ...fixture,
    secondScope,
    original: fixture.snapshot(),
    config: maintenanceConfig(fixture.scope.storePath),
  };
}

async function embedFixtureArchive(fixture: Awaited<ReturnType<typeof createFixture>>) {
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
          .select("event_json")
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
        {
          type: "custom",
          id: `${sessionId}-event`,
          customType: "large-artifact",
          data: { text: "x".repeat(34 * 1024 * 1024) },
        },
      ]);
      await waitForSessionTranscriptIndexReconcile(options);
      await replaceSessionEntry(scope, { sessionId, updatedAt: 1 });
      runOpenClawAgentWriteTransaction(({ db: database }) => {
        executeSqliteQuerySync(
          database,
          getNodeSqliteKysely<DB>(database)
            .updateTable("session_windows")
            .set({ updated_at: 1, transcript_updated_at: 1 })
            .where("session_id", "=", sessionId),
        );
      }, options);
      originalHashes.set(sessionId, transcriptHash(sessionId));
    }
    const config = maintenanceConfig(storePath);
    await expect(runSessionColdStorageMaintenance({ config })).resolves.toEqual({
      archivedTranscripts: 1,
      externalizedTranscripts: 0,
    });
    const database = openOpenClawAgentDatabase(options).db;
    const remaining = executeSqliteQuerySync(
      database,
      getNodeSqliteKysely<DB>(database)
        .selectFrom("transcript_events")
        .select("session_id")
        .distinct(),
    ).rows;
    expect(remaining).toHaveLength(1);
    const remainingId = remaining[0]!.session_id;
    expect(transcriptHash(remainingId)).toBe(originalHashes.get(remainingId));
    expect(
      database.prepare("SELECT COUNT(*) AS count FROM session_transcript_cold_archives").get(),
    ).toEqual({ count: 1 });
    await expect(runSessionColdStorageMaintenance({ config })).resolves.toEqual({
      archivedTranscripts: 1,
      externalizedTranscripts: 0,
    });
    expect(database.prepare("SELECT COUNT(*) AS count FROM transcript_events").get()).toEqual({
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
    closeOpenClawAgentDatabasesForTest();
    const pathname = fixture.scope.storePath;
    await fs.chmod(pathname, 0o400);
    const originalMode = (await fs.stat(pathname)).mode;
    const originalHash = createHash("sha256")
      .update(await fs.readFile(pathname))
      .digest("hex");
    try {
      await expect(
        runSessionColdStorageMaintenance({ config: maintenanceConfig(pathname) }),
      ).resolves.toEqual({ archivedTranscripts: 0, externalizedTranscripts: 0 });
      expect((await fs.stat(pathname)).mode).toBe(originalMode);
      expect(
        createHash("sha256")
          .update(await fs.readFile(pathname))
          .digest("hex"),
      ).toBe(originalHash);
      expect(getOpenClawAgentDatabaseIfOpen(fixture.options)).toBeUndefined();
    } finally {
      await fs.chmod(pathname, 0o600);
    }
  });

  it("archives several inactive sessions in one maintenance pass and restores both exactly", async () => {
    const fixture = await createBatchFixture();
    await expect(runSessionColdStorageMaintenance({ config: fixture.config })).resolves.toEqual({
      archivedTranscripts: 2,
      externalizedTranscripts: 0,
    });
    expect(readSessionColdTranscript(fixture.database(), historicalId)).toBeDefined();
    expect(
      readSessionColdTranscript(fixture.database(), fixture.secondScope.sessionId),
    ).toBeDefined();
    await restoreSessionColdTranscript(fixture.scope);
    await restoreSessionColdTranscript(fixture.secondScope);
    expect(fixture.snapshot()).toEqual(fixture.original);
  });

  it("leaves hot and embedded archives untouched while maintenance is disabled", async () => {
    const fixture = await createFixture();
    const { archivePath } = await embedFixtureArchive(fixture);
    const before = fixture.snapshot();
    const descriptor = fixture
      .database()
      .prepare("SELECT * FROM session_transcript_cold_archives")
      .get();
    await expect(
      runSessionColdStorageMaintenance({
        config: maintenanceConfig(fixture.scope.storePath, false),
      }),
    ).resolves.toEqual({
      archivedTranscripts: 0,
      externalizedTranscripts: 0,
    });
    expect(fixture.snapshot()).toEqual(before);
    expect(
      fixture.database().prepare("SELECT * FROM session_transcript_cold_archives").get(),
    ).toEqual(descriptor);
    await expect(fs.access(archivePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("externalizes a backup-embedded archive without restoring or rewriting its history", async () => {
    const fixture = await createFixture();
    const { descriptor, archivePath, bytes } = await embedFixtureArchive(fixture);
    const before = fixture.snapshot();
    await expect(
      runSessionColdStorageMaintenance({ config: maintenanceConfig(fixture.scope.storePath) }),
    ).resolves.toEqual({
      archivedTranscripts: 0,
      externalizedTranscripts: 1,
    });
    expect(fixture.snapshot()).toEqual(before);
    expect(readSessionColdTranscript(fixture.database(), historicalId)).toEqual(descriptor);
    expect(
      fixture.database().prepare("SELECT archive_blob FROM session_transcript_cold_archives").get(),
    ).toEqual({ archive_blob: null });
    expect(await fs.readFile(archivePath)).toEqual(bytes);
  });

  it("keeps the embedded backup blob when publication collides with a corrupt file", async () => {
    const fixture = await createFixture();
    const { archivePath, bytes } = await embedFixtureArchive(fixture);
    const before = fixture.snapshot();
    const descriptor = fixture
      .database()
      .prepare("SELECT * FROM session_transcript_cold_archives")
      .get();
    await fs.writeFile(archivePath, Buffer.alloc(bytes.length));
    await expect(
      runSessionColdStorageMaintenance({ config: maintenanceConfig(fixture.scope.storePath) }),
    ).rejects.toThrow(/collision|verification/);
    expect(
      fixture.database().prepare("SELECT * FROM session_transcript_cold_archives").get(),
    ).toEqual(descriptor);
    expect(fixture.snapshot()).toEqual(before);
  });

  it("lets hot appends finish during batch preparation and skips only the changed candidate", async () => {
    const fixture = await createBatchFixture();
    const entered = createDeferred();
    const release = createDeferred();
    const originalWorker = archiveWorkers.runSqliteTranscriptArchiveWorkerOperation;
    let held = false;
    vi.spyOn(archiveWorkers, "runSqliteTranscriptArchiveWorkerOperation").mockImplementation(
      async (params) => {
        const result = await originalWorker(params);
        if (
          !held &&
          "operation" in params.workerData &&
          params.workerData.operation === "cold-prepare"
        ) {
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
      const before = fixture
        .database()
        .prepare("SELECT * FROM transcript_events WHERE session_id = ? ORDER BY seq")
        .all(fixture.secondScope.sessionId);
      await withTestTimeout(
        appendTranscriptEvent(fixture.secondScope, {
          type: "custom",
          id: "during-cold-prepare",
          customType: "activity",
          data: {},
        }),
        5_000,
        "Hot append waited for cold archive preparation",
      );
      const after = fixture
        .database()
        .prepare("SELECT * FROM transcript_events WHERE session_id = ? ORDER BY seq")
        .all(fixture.secondScope.sessionId);
      expect(after.slice(0, before.length)).toEqual(before);
      expect(after).toHaveLength(before.length + 1);
    } finally {
      release.resolve();
      await maintenance;
    }
    await expect(maintenance).resolves.toEqual({
      archivedTranscripts: 1,
      externalizedTranscripts: 0,
    });
    expect(readSessionColdTranscript(fixture.database(), historicalId)).toBeDefined();
    expect(
      readSessionColdTranscript(fixture.database(), fixture.secondScope.sessionId),
    ).toBeUndefined();
  });

  it("rolls back every candidate when maintenance authority is revoked at commit", async () => {
    const fixture = await createBatchFixture();
    const originalWorker = archiveWorkers.runSqliteTranscriptArchiveWorkerOperation;
    let prepared = false;
    let revoked = false;
    vi.spyOn(archiveWorkers, "runSqliteTranscriptArchiveWorkerOperation").mockImplementation(
      async (params) => {
        if ("operation" in params.workerData && params.workerData.operation === "cold-prepare") {
          const result = await originalWorker(params);
          prepared = true;
          return result;
        }
        if (
          prepared &&
          "operation" in params.workerData &&
          params.workerData.operation === "cold-mutate"
        ) {
          return originalWorker({
            ...params,
            onCommitRequest: () => {
              revoked = true;
              params.onCommitRequest?.();
            },
          });
        }
        return originalWorker(params);
      },
    );
    await expect(
      runSessionColdStorageMaintenance({
        config: fixture.config,
        assertCurrent: () => {
          if (revoked) {
            throw new Error("Test maintenance authority was revoked");
          }
        },
      }),
    ).rejects.toThrow(/revoked|authorization|refus/i);
    expect(prepared).toBe(true);
    expect(revoked).toBe(true);
    expect(fixture.snapshot()).toEqual(fixture.original);
    expect(
      fixture.database().prepare("SELECT * FROM session_transcript_cold_archives").all(),
    ).toEqual([]);
  });

  it("preserves cold metadata, refuses synchronous history and retention deletion, and restores on async read", async () => {
    const fixture = await createFixture();
    const stats = readTranscriptStatsSync(fixture.scope);
    const version = readTranscriptContextVersionInTransaction(
      { db: fixture.database() },
      historicalId,
    );
    const events = loadTranscriptEventsSync(fixture.scope);
    await archiveFixture(fixture);
    expect(readTranscriptStatsSync(fixture.scope)).toEqual(stats);
    expect(
      readTranscriptContextVersionInTransaction({ db: fixture.database() }, historicalId),
    ).toEqual(version);
    for (const read of [
      () => loadTranscriptEventsSync(fixture.scope),
      () => readSessionTranscriptHistoryEvents(fixture.scope),
      () => loadTranscriptHeaderSync(fixture.scope),
      () => loadTranscriptTailEventsSync(fixture.scope, 1),
    ]) {
      expect(read).toThrow(expect.objectContaining({ code: "TRANSCRIPT_COLD" }));
    }
    expect(
      planSessionStateDeleteIfUnreferenced({
        archiveDirectory: path.dirname(fixture.scope.storePath),
        database: openOpenClawAgentDatabase(fixture.options),
        referencedSessionIds: new Set(),
        sessionId: historicalId,
      }),
    ).toBeNull();
    await expect(loadTranscriptEvents(fixture.scope)).resolves.toEqual(events);
    expect(fixture.snapshot()).toEqual(fixture.original);
  });

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
            event_json: JSON.stringify({ type: "session", id: sessionId }),
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
    await expect(
      runSessionColdStorageMaintenance({
        config: {
          agents: { list: [{ id: "main" }] },
          session: {
            store: fixture.scope.storePath,
            maintenance: { coldStorage: { enabled: true, afterDays: 30 } },
          },
        },
      }),
    ).resolves.toEqual({ archivedTranscripts: 1, externalizedTranscripts: 0 });
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

  it.each(["file", "sqlite"] as const)(
    "restores exact history and projections from %s after reopening",
    async (storage) => {
      const fixture = await createFixture();
      const { archivePath, bytes } = await archiveFixture(fixture);
      if (storage === "sqlite") {
        runOpenClawAgentWriteTransaction(({ db: database }) => {
          executeSqliteQuerySync(
            database,
            getNodeSqliteKysely<DB>(database)
              .updateTable("session_transcript_cold_archives")
              .set({ storage, archive_blob: bytes })
              .where("session_id", "=", historicalId),
          );
        }, fixture.options);
        await fs.unlink(archivePath);
      }
      closeOpenClawAgentDatabasesForTest();
      await restoreSessionColdTranscript(fixture.scope);
      expect(fixture.snapshot()).toEqual(fixture.original);
      expect(readSessionColdTranscript(fixture.database(), historicalId)).toBeUndefined();
      expect(fixture.database().prepare("PRAGMA quick_check").get()).toEqual({ quick_check: "ok" });
      expect(fixture.database().prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      await restoreSessionColdTranscript(fixture.scope);
      expect(fixture.snapshot()).toEqual(fixture.original);
    },
  );

  it("keeps recently active and running current transcripts hot", async () => {
    const fixture = await createFixture();
    const config = maintenanceConfig(fixture.scope.storePath);
    const currentBefore = fixture
      .database()
      .prepare("SELECT * FROM transcript_events WHERE session_id = ? ORDER BY seq")
      .all(currentId);
    expect(await runSessionColdStorageMaintenance({ config })).toEqual({
      archivedTranscripts: 1,
      externalizedTranscripts: 0,
    });
    expect(readSessionColdTranscript(fixture.database(), currentId)).toBeUndefined();
    expect(
      fixture
        .database()
        .prepare("SELECT * FROM transcript_events WHERE session_id = ? ORDER BY seq")
        .all(currentId),
    ).toEqual(currentBefore);
    await replaceSessionEntry(fixture.scope, {
      sessionId: currentId,
      updatedAt: 1,
      status: "running",
    });
    runOpenClawAgentWriteTransaction(({ db }) => {
      executeSqliteQuerySync(
        db,
        getNodeSqliteKysely<DB>(db)
          .updateTable("session_windows")
          .set({ updated_at: 1, transcript_updated_at: 1 })
          .where("session_id", "=", currentId),
      );
    }, fixture.options);
    const running = fixture.snapshot();
    expect(await runSessionColdStorageMaintenance({ config })).toEqual({
      archivedTranscripts: 0,
      externalizedTranscripts: 0,
    });
    expect(fixture.snapshot()).toEqual(running);
  });

  it("applies the configured day cutoff to historical transcript activity", async () => {
    const fixture = await createFixture();
    const updatedAt = Date.now() - 15 * 86_400_000;
    runOpenClawAgentWriteTransaction(({ db }) => {
      executeSqliteQuerySync(
        db,
        getNodeSqliteKysely<DB>(db)
          .updateTable("session_windows")
          .set({ updated_at: updatedAt, transcript_updated_at: updatedAt })
          .where("session_id", "=", historicalId),
      );
    }, fixture.options);
    const before = fixture.snapshot();
    expect(
      await runSessionColdStorageMaintenance({
        config: maintenanceConfig(fixture.scope.storePath, true, 30),
      }),
    ).toEqual({ archivedTranscripts: 0, externalizedTranscripts: 0 });
    expect(fixture.snapshot()).toEqual(before);
    expect(
      await runSessionColdStorageMaintenance({
        config: maintenanceConfig(fixture.scope.storePath, true, 7),
      }),
    ).toEqual({ archivedTranscripts: 1, externalizedTranscripts: 0 });
    expect(readSessionColdTranscript(fixture.database(), historicalId)).toBeDefined();
  });

  it.each([undefined, "running"] as const)(
    "archives old unreferenced history despite recent current metadata (%s)",
    async (status) => {
      const fixture = await createFixture();
      await replaceSessionEntry(fixture.scope, {
        sessionId: currentId,
        updatedAt: Date.now(),
        ...(status ? { status } : {}),
      });
      const currentBefore = fixture
        .database()
        .prepare("SELECT * FROM transcript_events WHERE session_id = ? ORDER BY seq")
        .all(currentId);
      const nodesBefore = fixture.database().prepare("SELECT * FROM session_nodes").all();
      expect(
        await runSessionColdStorageMaintenance({
          config: maintenanceConfig(fixture.scope.storePath),
        }),
      ).toEqual({ archivedTranscripts: 1, externalizedTranscripts: 0 });
      expect(
        fixture
          .database()
          .prepare("SELECT * FROM transcript_events WHERE session_id = ? ORDER BY seq")
          .all(currentId),
      ).toEqual(currentBefore);
      expect(fixture.database().prepare("SELECT * FROM session_nodes").all()).toEqual(nodesBefore);
      expect(readSessionColdTranscript(fixture.database(), historicalId)).toBeDefined();
    },
  );

  it("protects historical windows while their logical session has a real work admission", async () => {
    const fixture = await createFixture();
    const admission = await beginSessionWorkAdmission({
      scope: fixture.scope.storePath,
      identities: [fixture.scope.sessionKey],
      assertAllowed: () => {},
    });
    try {
      expect(
        await runSessionColdStorageMaintenance({
          config: maintenanceConfig(fixture.scope.storePath),
        }),
      ).toEqual({ archivedTranscripts: 0, externalizedTranscripts: 0 });
      expect(fixture.snapshot()).toEqual(fixture.original);
    } finally {
      admission.release();
      await admission.released;
    }
    expect(
      await runSessionColdStorageMaintenance({
        config: maintenanceConfig(fixture.scope.storePath),
      }),
    ).toEqual({ archivedTranscripts: 1, externalizedTranscripts: 0 });
  });

  it.each([
    { version: 19, expected: /uses schema version 19/ },
    { version: 20, expected: /no such table: session_transcript_cold_archives/ },
  ])(
    "rejects unmigrated or damaged schema $version instead of reporting zero transcripts",
    async ({ version, expected }) => {
      const fixture = await createFixture();
      const db = fixture.database();
      db.exec(`DROP TABLE session_transcript_cold_archives; PRAGMA user_version = ${version};`);
      db.prepare("UPDATE schema_meta SET schema_version = ? WHERE meta_key = 'primary'").run(
        version,
      );
      closeOpenClawAgentDatabasesForTest();
      const before = createHash("sha256")
        .update(await fs.readFile(fixture.scope.storePath))
        .digest("hex");
      await expect(
        getSessionColdStorageStatus(maintenanceConfig(fixture.scope.storePath)),
      ).rejects.toThrow(expected);
      expect(
        createHash("sha256")
          .update(await fs.readFile(fixture.scope.storePath))
          .digest("hex"),
      ).toBe(before);
      expect(getOpenClawAgentDatabaseIfOpen(fixture.options)).toBeUndefined();
    },
  );

  it("archives an inactive current transcript and restores its original bytes before appending", async () => {
    const fixture = await createFixture();
    const scope = { ...fixture.scope, sessionId: currentId };
    runOpenClawAgentWriteTransaction(({ db: database }) => {
      executeSqliteQuerySync(
        database,
        getNodeSqliteKysely<DB>(database)
          .updateTable("session_windows")
          .set({ updated_at: 1, transcript_updated_at: 1 })
          .where("session_id", "=", currentId),
      );
    }, fixture.options);
    const before = fixture
      .database()
      .prepare("SELECT * FROM transcript_events WHERE session_id = ? ORDER BY seq")
      .all(currentId);
    expect(
      await runSessionColdStorageMaintenance({
        config: maintenanceConfig(fixture.scope.storePath),
      }),
    ).toEqual({ archivedTranscripts: 2, externalizedTranscripts: 0 });
    expect(readSessionColdTranscript(fixture.database(), currentId)).toBeDefined();
    await appendTranscriptEvent(scope, {
      type: "custom",
      id: "after-cold-restore",
      customType: "restored",
      data: {},
    });
    const after = fixture
      .database()
      .prepare("SELECT * FROM transcript_events WHERE session_id = ? ORDER BY seq")
      .all(currentId);
    expect(after.slice(0, before.length)).toEqual(before);
    expect(after).toHaveLength(before.length + 1);
    expect(readSessionColdTranscript(fixture.database(), currentId)).toBeUndefined();
    await replaceSessionEntry(scope, { sessionId: currentId, updatedAt: 1 });
    runOpenClawAgentWriteTransaction(({ db }) => {
      executeSqliteQuerySync(
        db,
        getNodeSqliteKysely<DB>(db)
          .updateTable("session_windows")
          .set({ updated_at: 1, transcript_updated_at: 1 })
          .where("session_id", "=", currentId),
      );
    }, fixture.options);
    const resumed = fixture.snapshot();
    expect(
      await runSessionColdStorageMaintenance({
        config: maintenanceConfig(fixture.scope.storePath),
      }),
    ).toEqual({ archivedTranscripts: 0, externalizedTranscripts: 0 });
    expect(fixture.snapshot()).toEqual(resumed);
  });

  it.each(["missing", "corrupt"] as const)(
    "retains the descriptor when its file is %s and recovers after repair",
    async (damage) => {
      const fixture = await createFixture();
      const { descriptor, archivePath, bytes } = await archiveFixture(fixture);
      if (damage === "missing") {
        await fs.unlink(archivePath);
      } else {
        await fs.writeFile(archivePath, Buffer.alloc(bytes.length));
      }
      await expect(restoreSessionColdTranscript(fixture.scope)).rejects.toThrow(
        damage === "missing" ? /missing or unreadable/ : /failed verification/,
      );
      expect(readSessionColdTranscript(fixture.database(), historicalId)).toEqual(descriptor);
      expect(
        fixture
          .database()
          .prepare("SELECT * FROM transcript_events WHERE session_id = ?")
          .all(historicalId),
      ).toEqual([]);
      await fs.writeFile(archivePath, bytes);
      await restoreSessionColdTranscript(fixture.scope);
      expect(fixture.snapshot()).toEqual(fixture.original);
    },
  );
});
