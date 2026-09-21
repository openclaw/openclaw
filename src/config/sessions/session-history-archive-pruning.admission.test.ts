import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { executeSqliteQuerySync } from "../../infra/kysely-sync.js";
import * as sqlite from "../../infra/node-sqlite.js";
import * as integrity from "../../infra/sqlite-integrity-worker.js";
import * as logging from "../../logging/logger.js";
import { invalidateOpenClawAgentDatabaseValidation } from "../../state/openclaw-agent-db-validation-cache.js";
import {
  closeOpenClawAgentDatabaseByPath,
  closeOpenClawAgentDatabasesAsync,
  getOpenClawAgentDatabaseIfOpen,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { clearOpenClawAgentIntegrityVerification } from "../../state/openclaw-quarantine-store.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import {
  appendTranscriptMessage,
  deleteSessionEntryLifecycle,
  replaceSessionEntry,
} from "./session-accessor.js";
import {
  getSessionKysely,
  runExclusiveSqliteSessionWrite,
} from "./session-accessor.sqlite-scope.js";
import {
  pruneAllSessionTranscriptArchivesToHighWater,
  reclaimSqliteFreePages,
} from "./session-history-archive-pruning.js";
import { resolveSqliteTargetFromSessionStorePath } from "./session-sqlite-target.js";

const hook = vi.hoisted(() => ({ afterMeasure: undefined as (() => void) | undefined }));
vi.mock("./disk-budget.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./disk-budget.js")>();
  return {
    ...actual,
    measureSessionPhysicalDiskUsage: async (
      ...args: Parameters<typeof actual.measureSessionPhysicalDiskUsage>
    ) => {
      const result = await actual.measureSessionPhysicalDiskUsage(...args);
      hook.afterMeasure?.();
      return result;
    },
  };
});

let state: OpenClawTestState;
const pending: Promise<unknown>[] = [];
const releases: Array<() => void> = [];
const realOpen = sqlite.openNodeSqliteDatabase;
const realIntegrity = integrity.assertSqliteIntegrityInWorker;

beforeEach(async () => {
  state = await createOpenClawTestState({
    prefix: "archive-pruning-admission-",
    layout: "state-only",
  });
});

afterEach(async () => {
  releases.splice(0).forEach((release) => release());
  await Promise.allSettled(pending.splice(0));
  hook.afterMeasure = undefined;
  vi.restoreAllMocks();
  await closeOpenClawAgentDatabasesAsync();
  await state.cleanup();
});

function own<T>(promise: Promise<T>): Promise<T> {
  pending.push(promise);
  void promise.catch(() => {});
  return promise;
}

function observePruningFailures() {
  const warnings: unknown[] = [];
  const getChildLogger = logging.getChildLogger;
  vi.spyOn(logging, "getChildLogger").mockImplementation((...args) => {
    const logger = getChildLogger(...args);
    vi.spyOn(logger, "warn").mockImplementation((message, fields) => {
      if (message === "SQLite session write failed") {
        assert(fields && typeof fields === "object");
        warnings.push("archivePruning" in fields ? fields.archivePruning : undefined);
      }
      return undefined;
    });
    return logger;
  });
  return warnings;
}

it("does not invent an admission mode when a warm database rejects a different owner", async () => {
  const options = { agentId: "main", env: state.env };
  const database = openOpenClawAgentDatabase(options);
  const before = database.db.prepare("SELECT total_changes() AS changes").get();
  const checkpoint = vi.spyOn(database.walMaintenance, "reclaimFreePages");
  const warnings = observePruningFailures();
  const archivePruning = { trigger: "initial" as const };
  const wrongOwner = { ...options, agentId: "other", path: database.path };
  await expect(
    runExclusiveSqliteSessionWrite(
      wrongOwner,
      async () =>
        pruneAllSessionTranscriptArchivesToHighWater({
          archiveDirectory: state.sessionsDir(),
          databaseOptions: wrongOwner,
          diagnostics: archivePruning,
          highWaterBytes: 0,
          storePath: path.join(state.sessionsDir(), "sessions.json"),
        }),
      "session.history.archive-prune",
      { archivePruning },
    ),
  ).rejects.toThrow("already open for agent main; requested agent other");
  expect(getOpenClawAgentDatabaseIfOpen(options)).toBe(database);
  expect(checkpoint).not.toHaveBeenCalled();
  expect(database.db.prepare("SELECT total_changes() AS changes").get()).toEqual(before);
  expect(warnings).toEqual([
    expect.objectContaining({
      trigger: "initial",
      completed: false,
      admissionMs: expect.any(Number),
      cachedAdmissions: undefined,
      asyncAdmissions: undefined,
      checkpointCalls: undefined,
    }),
  ]);
});

const boundaries = ["drain", "presence", "row", "unpublished", "removed-file"] as const;

it.each([false, true])(
  "does not wait for a pinned reader during page reclamation (free pages: %s)",
  async (withFreePages) => {
    const options = { agentId: "main", env: state.env };
    const database = openOpenClawAgentDatabase(options);
    database.db.exec("PRAGMA wal_autocheckpoint = 0");
    if (withFreePages) {
      database.db
        .prepare("INSERT INTO cache_entries(scope, key, blob, updated_at) VALUES (?, ?, ?, ?)")
        .run("checkpoint-proof", "padding", Buffer.alloc(4 * 1024 * 1024), 1);
      database.db.prepare("DELETE FROM cache_entries WHERE scope = ?").run("checkpoint-proof");
    }
    expect(database.walMaintenance.checkpoint()).toBe(true);
    const busyTimeout = database.db.prepare("PRAGMA busy_timeout").get();
    const reader = realOpen(database.path, { readOnly: true });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      reader.exec("BEGIN");
      reader.prepare("SELECT COUNT(*) FROM cache_entries").get();
      database.db
        .prepare("INSERT INTO cache_entries(scope, key, blob, updated_at) VALUES (?, ?, ?, ?)")
        .run("checkpoint-proof", "new-frame", Buffer.from("retained"), 2);
      const freePages = () =>
        Number(database.db.prepare("PRAGMA freelist_count").get()?.freelist_count);
      const before = freePages();
      expect(withFreePages ? before > 512 : before === 0).toBe(true);
      const diagnostics = { trigger: "initial" as const };
      const startedAt = performance.now();
      let releasedAt = 0;
      const released = new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          reader.exec("ROLLBACK");
          releasedAt = performance.now() - startedAt;
          resolve();
        }, 10);
      });
      await reclaimSqliteFreePages(options, diagnostics, { maxPasses: 1 });
      const elapsedMs = performance.now() - startedAt;
      expect(freePages()).toBe(before);
      expect(diagnostics).toMatchObject({ checkpointCalls: 1, checkpointIncomplete: 1 });
      expect(database.db.prepare("PRAGMA busy_timeout").get()).toEqual(busyTimeout);
      await released;
      // This is a lock-wait bound, not a sub-millisecond performance benchmark.
      expect(elapsedMs).toBeLessThan(1_000);
      expect(releasedAt).toBeLessThan(1_000);
      await reclaimSqliteFreePages(options);
      expect(freePages()).toBe(0);
      expect(
        database.db
          .prepare("SELECT blob FROM cache_entries WHERE scope = ? AND key = ?")
          .get("checkpoint-proof", "new-frame")?.blob,
      ).toEqual(new Uint8Array(Buffer.from("retained")));
      expect(database.walMaintenance.checkpoint()).toBe(true);
      expect(fs.statSync(`${database.path}-wal`).size).toBe(0);
      expect(database.db.prepare("PRAGMA busy_timeout").get()).toEqual(busyTimeout);
    } finally {
      clearTimeout(timer);
      if (reader.isTransaction) {
        reader.exec("ROLLBACK");
      }
      reader.close();
    }
  },
  20_000,
);

it("defers vacuum when a writer acquires its lock after checkpoint", async () => {
  const options = { agentId: "main", env: state.env };
  const database = openOpenClawAgentDatabase(options);
  database.db.exec("PRAGMA wal_autocheckpoint = 0");
  database.db
    .prepare("INSERT INTO cache_entries(scope, key, blob, updated_at) VALUES (?, ?, ?, ?)")
    .run("vacuum-admission", "padding", Buffer.alloc(4 * 1024 * 1024), 1);
  database.db.prepare("DELETE FROM cache_entries WHERE scope = ?").run("vacuum-admission");
  expect(database.walMaintenance.checkpoint()).toBe(true);
  const freePages = () =>
    Number(database.db.prepare("PRAGMA freelist_count").get()?.freelist_count);
  const before = freePages();
  expect(before).toBeGreaterThan(512);
  const busyTimeout = database.db.prepare("PRAGMA busy_timeout").get();
  const writer = realOpen(database.path);
  const prepare = database.db.prepare.bind(database.db);
  let checkpointObserved = false;
  const checkpointSpy = vi.spyOn(database.db, "prepare").mockImplementation((sql) => {
    const statement = prepare(sql);
    if (sql === "PRAGMA wal_checkpoint(TRUNCATE);" && !checkpointObserved) {
      const get = statement.get.bind(statement);
      statement.get = () => {
        const row = get();
        checkpointObserved = true;
        writer.exec("BEGIN IMMEDIATE");
        return row;
      };
    }
    return statement;
  });
  try {
    const startedAt = performance.now();
    await runExclusiveSqliteSessionWrite(
      options,
      () => reclaimSqliteFreePages(options),
      "session.history.free-pages",
    );
    expect(performance.now() - startedAt).toBeLessThan(1_000);
    expect(writer.isTransaction).toBe(true);
    expect(database.db.isTransaction).toBe(false);
    expect(database.db.prepare("PRAGMA busy_timeout").get()).toEqual(busyTimeout);
    expect(freePages()).toBe(before);
    writer.exec("ROLLBACK");
    await runExclusiveSqliteSessionWrite(
      options,
      () => reclaimSqliteFreePages(options),
      "session.history.free-pages",
    );
    expect(freePages()).toBe(0);
    expect(database.db.prepare("PRAGMA busy_timeout").get()).toEqual(busyTimeout);
  } finally {
    checkpointSpy.mockRestore();
    if (writer.isTransaction) {
      writer.exec("ROLLBACK");
    }
    writer.close();
  }
});

it("bounds background page reclamation and checks authority before resuming it", async () => {
  const options = { agentId: "main", env: state.env };
  const database = openOpenClawAgentDatabase(options);
  database.db
    .prepare("INSERT INTO cache_entries(scope, key, blob, updated_at) VALUES (?, ?, ?, ?)")
    .run("cold-proof", "padding", Buffer.alloc(4 * 1024 * 1024), 1);
  database.db.prepare("DELETE FROM cache_entries WHERE scope = ?").run("cold-proof");
  const freePages = () =>
    Number(database.db.prepare("PRAGMA freelist_count").get()?.freelist_count);
  const before = freePages();
  expect(before).toBeGreaterThan(512);
  await reclaimSqliteFreePages(options, undefined, { maxPasses: 1 });
  const remaining = freePages();
  expect(remaining).toBeGreaterThan(0);
  expect(remaining).toBeLessThan(before);
  expect(before - remaining).toBeLessThanOrEqual(512);
  await expect(
    reclaimSqliteFreePages(options, undefined, {
      maxPasses: 1,
      assertCurrent: () => {
        throw new Error("maintenance stopped");
      },
    }),
  ).rejects.toThrow("maintenance stopped");
  expect(freePages()).toBe(remaining);
  await reclaimSqliteFreePages(options);
  expect(freePages()).toBe(0);
});

it.each([
  ...boundaries.flatMap((boundary) =>
    [false, true].map((cold) => ({ boundary, cold, outcome: "complete" as const })),
  ),
  { boundary: "drain", cold: true, outcome: "revoked" },
  { boundary: "removed-file", cold: true, outcome: "revoked" },
  { boundary: "row", cold: true, outcome: "unpublished" },
] as const)(
  "keeps $boundary archive maintenance inside its writer FIFO (cold: $cold, outcome: $outcome)",
  async ({ boundary, cold, outcome }) => {
    const sessionsDir = state.sessionsDir();
    fs.mkdirSync(sessionsDir, { recursive: true });
    const storePath = path.join(sessionsDir, "sessions.json");
    const sessionKey = "agent:main:archive-admission";
    const sessionId = "archived-generation";
    await replaceSessionEntry({ sessionKey, storePath }, { sessionId, updatedAt: 1 });
    await appendTranscriptMessage(
      { sessionKey, sessionId, storePath },
      { message: { role: "user", content: "synthetic retained archive payload" } },
    );
    const deletion = await deleteSessionEntryLifecycle({
      storePath,
      target: { canonicalKey: sessionKey, storeKeys: [sessionKey] },
      archiveTranscript: true,
    });
    const archivePath = deletion.archivedTranscripts[0]?.archivedPath;
    assert(archivePath);
    const archivedBytes = fs.readFileSync(archivePath);
    const target = resolveSqliteTargetFromSessionStorePath(storePath);
    const options = { agentId: target.agentId ?? "main", path: target.path };
    const database = openOpenClawAgentDatabase(options);
    const markUnpublished = (db: DatabaseSync) => {
      executeSqliteQuerySync(
        db,
        getSessionKysely(db)
          .updateTable("session_transcript_archives")
          .set({ published_at: null })
          .where("session_id", "=", sessionId),
      );
    };
    const readArchive = (db: DatabaseSync) =>
      executeSqliteQuerySync(
        db,
        getSessionKysely(db)
          .selectFrom("session_transcript_archives")
          .selectAll()
          .where("session_id", "=", sessionId),
      ).rows[0];
    if (boundary === "unpublished") {
      markUnpublished(database.db);
    }
    const originalArchive = readArchive(database.db);
    assert(originalArchive);
    database.db.exec("PRAGMA incremental_vacuum;");
    database.walMaintenance.checkpoint();
    if (boundary === "drain") {
      // sqlite-allow-raw -- Disposable bootstrap pages exercise multiple real vacuum passes.
      database.db.exec(`CREATE TABLE cold_drain_fixture (payload BLOB);
        INSERT INTO cold_drain_fixture VALUES (zeroblob(8388608));
        DROP TABLE cold_drain_fixture;`);
      database.walMaintenance.checkpoint();
    }
    const readFreePages = (db: DatabaseSync) =>
      Number(db.prepare("PRAGMA freelist_count").get()?.freelist_count);
    const initialFreePages = readFreePages(database.db);
    if (boundary === "drain") {
      expect(initialFreePages).toBeGreaterThan(512);
    } else {
      expect(initialFreePages).toBe(0);
    }
    const legacyPath = path.join(sessionsDir, "legacy.jsonl.deleted.2020-01-01T00-00-00.000Z");
    if (boundary === "unpublished") {
      fs.writeFileSync(legacyPath, "synthetic old archive");
    }

    const events: string[] = [];
    let active = false;
    let reached = false;
    let closed = false;
    let inTransaction = false;
    let observing = false;
    let parentChecks = 0;
    let childChecks = 0;
    let laterWriterRan = false;
    let firstDrainedPages = 0;
    const childEntered = createDeferred();
    const releaseChild = createDeferred();
    const blockerEntered = createDeferred();
    const releaseBlocker = createDeferred();
    releases.push(
      () => releaseChild.resolve(),
      () => releaseBlocker.resolve(),
    );

    const arrive = () => {
      if (reached) {
        return;
      }
      reached = true;
      events.push("boundary");
      inTransaction = database.db.isTransaction;
      if (cold) {
        closed = closeOpenClawAgentDatabaseByPath(database.path);
        invalidateOpenClawAgentDatabaseValidation(database.path);
        clearOpenClawAgentIntegrityVerification(database.path, state.env);
      }
      observing = true;
    };
    const observe = (db: DatabaseSync) => {
      const prepare = db.prepare.bind(db);
      vi.spyOn(db, "prepare").mockImplementation((sql) => {
        const statement = prepare(sql);
        if (sql === "PRAGMA integrity_check;") {
          const all = statement.all.bind(statement);
          statement.all = () => {
            if (observing) {
              parentChecks += 1;
            }
            return all();
          };
        }
        if (sql === "PRAGMA freelist_count" && boundary === "presence") {
          const get = statement.get.bind(statement);
          statement.get = () => {
            const row = get();
            if (active && !reached && Number(row?.freelist_count) === 0) {
              queueMicrotask(arrive);
            }
            return row;
          };
        }
        return statement;
      });
    };
    observe(database.db);
    vi.spyOn(sqlite, "openNodeSqliteDatabase").mockImplementation((pathname, openOptions) => {
      const opened = realOpen(pathname, openOptions);
      if (pathname === database.path && !openOptions?.readOnly) {
        observe(opened);
      }
      return opened;
    });
    vi.spyOn(integrity, "assertSqliteIntegrityInWorker").mockImplementation((...args) => {
      const check = realIntegrity(...args);
      if (!observing || args[0] !== database.path) {
        return check;
      }
      childChecks += 1;
      childEntered.resolve();
      return Promise.all([check, releaseChild.promise]).then(() => undefined);
    });
    if (boundary === "row" || boundary === "unpublished") {
      hook.afterMeasure = () => {
        if (active) {
          arrive();
        }
      };
    }
    const rm = fs.promises.rm.bind(fs.promises);
    vi.spyOn(fs.promises, "rm").mockImplementation(async (...args) => {
      const result = await rm(...args);
      if (active && boundary === "removed-file" && args[0] === archivePath) {
        arrive();
      }
      return result;
    });

    void own(
      runExclusiveSqliteSessionWrite(
        options,
        async () => {
          blockerEntered.resolve();
          await releaseBlocker.promise;
          events.push("blocker-released");
        },
        "session.history.archive-prune",
      ),
    );
    await blockerEntered.promise;
    const archivePruning = { trigger: "initial" as const };
    const warnings = observePruningFailures();
    const work = own(
      runExclusiveSqliteSessionWrite(
        options,
        async () => {
          active = true;
          events.push("maintenance-entered");
          try {
            if (boundary === "drain") {
              // A prior writer may yield before this admission starts. Observe only our passes.
              void own(
                yieldToEventLoop().then(() => {
                  firstDrainedPages = initialFreePages - readFreePages(database.db);
                  arrive();
                }),
              );
            }
            return boundary === "drain"
              ? await reclaimSqliteFreePages(options, archivePruning)
              : await pruneAllSessionTranscriptArchivesToHighWater({
                  archiveDirectory: path.dirname(archivePath),
                  diagnostics: archivePruning,
                  databaseOptions: options,
                  highWaterBytes: 1,
                  storePath,
                });
          } finally {
            active = false;
            events.push("maintenance-exited");
          }
        },
        "session.history.archive-prune",
        { archivePruning },
      ),
    );
    const later = own(
      runExclusiveSqliteSessionWrite(
        options,
        async () => {
          laterWriterRan = true;
          events.push("later-writer");
        },
        "session.history.archive-prune",
      ),
    );
    releaseBlocker.resolve();
    const completion = await Promise.race([
      childEntered.promise.then(() => "child" as const),
      work.then(() => "completed" as const),
    ]);
    if (completion === "child") {
      await yieldToEventLoop();
      expect(laterWriterRan).toBe(false);
      if (outcome === "revoked") {
        closeOpenClawAgentDatabaseByPath(database.path);
      } else if (outcome === "unpublished") {
        const peer = realOpen(database.path);
        try {
          markUnpublished(peer);
        } finally {
          peer.close();
        }
      }
    }
    releaseChild.resolve();
    if (outcome === "revoked") {
      await expect(work).rejects.toThrow(/revoked/);
      expect(getOpenClawAgentDatabaseIfOpen(options)).toBeUndefined();
      expect(warnings).toEqual([
        expect.objectContaining({
          trigger: "initial",
          completed: false,
          asyncAdmissions: 1,
          admissionMs: expect.any(Number),
          checkpointCalls: expect.any(Number),
          checkpointMs: expect.any(Number),
        }),
      ]);
    } else if (boundary === "drain") {
      await work;
    } else {
      await expect(work).resolves.toMatchObject({ removedFiles: outcome === "complete" ? 1 : 0 });
    }
    await later;
    observing = false;
    expect(reached).toBe(true);
    expect(closed).toBe(cold);
    expect(inTransaction).toBe(false);
    expect(completion).toBe(cold ? "child" : "completed");
    expect(parentChecks).toBe(0);
    expect(childChecks).toBe(cold ? 1 : 0);
    expect(events.indexOf("later-writer")).toBeGreaterThan(events.indexOf("maintenance-exited"));
    const reopened = openOpenClawAgentDatabase(options);
    const row = readArchive(reopened.db);
    if (boundary === "drain" || boundary === "unpublished" || outcome !== "complete") {
      expect(row).toEqual({
        ...originalArchive,
        ...(outcome === "unpublished" ? { published_at: null } : {}),
      });
      if (boundary === "removed-file") {
        expect(fs.existsSync(archivePath)).toBe(false);
      } else {
        expect(fs.readFileSync(archivePath)).toEqual(archivedBytes);
      }
    } else {
      expect(row).toBeUndefined();
      expect(fs.existsSync(archivePath)).toBe(false);
    }
    if (boundary === "drain") {
      expect(archivePruning).toMatchObject({
        vacuumMs: expect.any(Number),
        vacuumPasses: expect.any(Number),
        vacuumPagesRequested: outcome === "revoked" ? firstDrainedPages : initialFreePages,
      });
      expect(firstDrainedPages).toBeGreaterThan(0);
      expect(firstDrainedPages).toBeLessThanOrEqual(512);
      expect(readFreePages(reopened.db)).toBe(
        outcome === "revoked" ? initialFreePages - firstDrainedPages : 0,
      );
    }
  },
);
