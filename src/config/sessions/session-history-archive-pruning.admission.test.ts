import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred, withTestTimeout } from "../../../test/helpers/promise.js";
import { acquireStateDatabaseSchemaLease } from "../../infra/gateway-state-owner.js";
import { executeSqliteQuerySync } from "../../infra/kysely-sync.js";
import { openNodeSqliteDatabase, requireNodeSqlite } from "../../infra/node-sqlite.js";
import * as workerAdmission from "../../infra/sqlite-worker-operation-admission.js";
import { sqliteWorkerOwnerProbe as workerProbe } from "../../infra/sqlite-worker-owner-probe.test-support.js";
import { drainAgentDatabaseResources } from "../../state/openclaw-agent-db-resources.js";
import {
  closeOpenClawAgentDatabaseByPath,
  closeOpenClawAgentDatabaseByPathAsync,
  closeOpenClawAgentDatabasesAsync,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import { createOpenClawDatabaseMaintenanceScope } from "../../state/openclaw-state-db-async-lifecycle.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import * as diskBudgetFiles from "./disk-budget-files.js";
import * as diskBudget from "./disk-budget.js";
import { runExclusiveSqliteTranscriptArchiveWorker } from "./session-accessor.sqlite-archive.js";
import {
  loadSessionEntryReadOnly,
  replaceSessionEntry,
  replaceSessionEntrySync,
} from "./session-accessor.sqlite-entry.js";
import { deleteSessionEntryLifecycle } from "./session-accessor.sqlite-lifecycle.js";
import * as pageReclamation from "./session-accessor.sqlite-page-reclamation.js";
import {
  getSessionKysely,
  runExclusiveSqliteSessionWrite,
} from "./session-accessor.sqlite-scope.js";
import { appendTranscriptMessage } from "./session-accessor.sqlite-transcript-write.js";
import {
  pruneAllSessionTranscriptArchivesToHighWater,
  reclaimSqliteFreePages,
} from "./session-history-archive-pruning.js";
import { withSessionHistoryBudgetSweepsForTest } from "./session-history-budget.test-support.js";
import { enforceSqliteSessionHistoryDiskBudget } from "./session-history-eviction.js";
import { resolveSqliteTargetFromSessionStorePath } from "./session-sqlite-target.js";

let state: OpenClawTestState;
const pending: Promise<unknown>[] = [];
const releases: Array<() => void> = [];
const realOpen = openNodeSqliteDatabase;

beforeEach(async () => {
  state = await createOpenClawTestState({
    prefix: "archive-pruning-admission-",
    layout: "state-only",
  });
});

afterEach(async () => {
  releases.splice(0).forEach((release) => release());
  await Promise.allSettled(pending.splice(0));
  vi.restoreAllMocks();
  await closeOpenClawAgentDatabasesAsync();
  await state.cleanup();
});

function own<T>(promise: Promise<T>): Promise<T> {
  pending.push(promise);
  void promise.catch(() => {});
  return promise;
}

it.each([false, true])(
  "keeps native page cleanup outside archive admission (incognito: %s)",
  async (incognito) => {
    const options = {
      agentId: "main",
      env: state.env,
      ...(incognito
        ? { path: resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main", env: state.env }) }
        : {}),
    };
    const database = openOpenClawAgentDatabase(options);
    const nativeReclaim = vi.spyOn(database.walMaintenance, "reclaimFreePages");
    const schemaLease = incognito ? undefined : acquireStateDatabaseSchemaLease(database.path);
    const maintenance = schemaLease
      ? createOpenClawDatabaseMaintenanceScope({
          schemaMaintenance: true,
          assertOwnerCurrent: () => schemaLease.assertCurrent(),
          assertDatabaseAccess: schemaLease.assertDatabaseAccess,
        })
      : undefined;
    const entered = createDeferred();
    const release = createDeferred();
    releases.push(release.resolve);
    const blocker = own(
      runExclusiveSqliteTranscriptArchiveWorker(async () => {
        entered.resolve();
        await release.promise;
      }),
    );
    await entered.promise;
    const pageComplete = createDeferred();
    let archiveRead = false;
    const run = () =>
      pageReclamation.withSqliteSessionPageReclamation(
        options,
        async (reclaim, _assertCurrent, _databaseOptions, archives) => {
          expect(await reclaim(1)).toMatchObject({ checkpointCompleted: true });
          pageComplete.resolve();
          return archives.withWriter(async () => {
            archiveRead = true;
            return archives.read();
          });
        },
      );
    const work = own(maintenance ? maintenance.run(run) : run());
    void work.catch(pageComplete.reject);
    try {
      await withTestTimeout(
        pageComplete.promise,
        10_000,
        "Native page cleanup waited for archive admission",
      );
      expect(nativeReclaim).toHaveBeenCalledOnce();
      if (incognito) {
        await expect(work).resolves.toBeNull();
        expect(archiveRead).toBe(true);
        expect(fs.existsSync(database.path)).toBe(false);
      } else {
        expect(archiveRead).toBe(false);
      }
      release.resolve();
      await expect(work).resolves.toBeNull();
      expect(archiveRead).toBe(true);
    } finally {
      release.resolve();
      await Promise.allSettled([blocker, work]);
      try {
        await maintenance?.close();
      } finally {
        schemaLease?.release();
      }
    }
  },
);

it("retires a queued archive removal without waiting for unrelated archive work", async () => {
  const fixture = await publishedArchive();
  const entered = createDeferred();
  const release = createDeferred();
  const queued = createDeferred();
  releases.push(release.resolve);
  const blocker = own(
    runExclusiveSqliteTranscriptArchiveWorker(async () => {
      entered.resolve();
      await release.promise;
    }),
  );
  await entered.promise;
  const withPages = pageReclamation.withSqliteSessionPageReclamation;
  vi.spyOn(pageReclamation, "withSqliteSessionPageReclamation").mockImplementation(
    <T>(...args: Parameters<typeof withPages<T>>) => {
      const [input, run] = args;
      return withPages(input, (reclaim, assertCurrent, options, archives) =>
        run(reclaim, assertCurrent, options, {
          ...archives,
          withWriter: (operation) => {
            const work = archives.withWriter(operation);
            queued.resolve();
            return work;
          },
        }),
      );
    },
  );
  const work = fixture.prune();
  void work.catch(queued.reject);
  let retirement: Promise<void> | undefined;
  try {
    await withTestTimeout(queued.promise, 10_000, "Archive removal did not reach admission");
    retirement = own(
      drainAgentDatabaseResources(
        { path: fixture.options.path, agentId: fixture.options.agentId },
        async () => undefined,
      ),
    );
    await withTestTimeout(retirement, 10_000, "Retirement waited on queued archive removal");
    release.resolve();
    const failure: unknown = await work.catch((error: unknown) => error);
    await blocker;
    expect(fixture.readArchive()).toEqual(fixture.originalArchive);
    expect(fs.readFileSync(fixture.archivePath)).toEqual(fixture.archivedBytes);
    expect(failure).toBeInstanceOf(Error);
    expect(String(failure)).toMatch(/revoked|closed/);
  } finally {
    release.resolve();
    await Promise.allSettled([blocker, work, retirement]);
  }
});

async function publishedArchive(content = "synthetic retained archive payload") {
  const sessionsDir = state.sessionsDir();
  fs.mkdirSync(sessionsDir, { recursive: true });
  const storePath = path.join(sessionsDir, "sessions.json");
  const sessionKey = "agent:main:archive-admission";
  const sessionId = "archived-generation";
  await replaceSessionEntry({ sessionKey, storePath }, { sessionId, updatedAt: 1 });
  await appendTranscriptMessage(
    { sessionKey, sessionId, storePath },
    { message: { role: "user", content } },
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
  const options = { agentId: target.agentId ?? "main", path: target.path, env: state.env };
  const readArchive = () => {
    const database = openOpenClawAgentDatabase(options);
    return executeSqliteQuerySync(
      database.db,
      getSessionKysely(database.db)
        .selectFrom("session_transcript_archives")
        .selectAll()
        .where("session_id", "=", sessionId),
    ).rows[0];
  };
  const originalArchive = readArchive();
  assert(originalArchive);
  return {
    options,
    storePath,
    sessionId,
    archivePath,
    archivedBytes,
    originalArchive,
    readArchive,
    prune: (highWaterBytes = 1, databaseOptions = options) =>
      own(
        pruneAllSessionTranscriptArchivesToHighWater({
          archiveDirectory: sessionsDir,
          databaseOptions,
          highWaterBytes,
          storePath,
        }),
      ),
  };
}

it("enforces a physical archive budget without ordinary host SQLite calls", async () => {
  const fixture = await withSessionHistoryBudgetSweepsForTest(() =>
    publishedArchive(randomBytes(128 * 1024).toString("base64")),
  );
  const retained = { sessionKey: "agent:main:guard-retained", storePath: fixture.storePath };
  replaceSessionEntrySync(retained, { sessionId: "guard-retained", updatedAt: 1 });
  const database = openOpenClawAgentDatabase(fixture.options);
  database.walMaintenance.checkpoint();
  database.db.exec("PRAGMA incremental_vacuum;");
  database.walMaintenance.checkpoint();
  const unpadded = await diskBudget.measureSessionPhysicalDiskUsage(fixture.storePath);
  const highWaterBytes = unpadded.totalBytes - Math.floor(fixture.archivedBytes.length / 2);
  const pageSize = Number(database.db.prepare("PRAGMA page_size").get()?.page_size);
  // sqlite-allow-raw -- Setup needs several real page units before archive selection and deletion.
  database.db
    .prepare(
      "INSERT INTO cache_entries(scope, key, blob, updated_at) VALUES (?, ?, zeroblob(?), 1)",
    )
    .run("archive-worker-proof", "free-pages", pageSize * 1536);
  database.db.prepare("DELETE FROM cache_entries WHERE scope = ?").run("archive-worker-proof");
  database.walMaintenance.checkpoint();
  expect(
    Number(database.db.prepare("PRAGMA freelist_count").get()?.freelist_count),
  ).toBeGreaterThan(1024);
  const sqlite = requireNodeSqlite();
  const prepare = vi.spyOn(sqlite.DatabaseSync.prototype, "prepare");
  // oxlint-disable-next-line typescript/unbound-method -- Forward native exec with its original database receiver.
  const originalExec = sqlite.DatabaseSync.prototype.exec;
  const executions: Array<{ location: string | null; sql: string }> = [];
  const exec = vi.spyOn(sqlite.DatabaseSync.prototype, "exec").mockImplementation(function (
    this: DatabaseSync,
    sql,
  ) {
    executions.push({ location: this.location(), sql });
    return Reflect.apply(originalExec, this, [sql]);
  });
  const statements = (["get", "all", "run", "iterate"] as const).map((method) =>
    vi.spyOn(sqlite.StatementSync.prototype, method),
  );
  const probes = [prepare, exec, ...statements];
  let result: Awaited<ReturnType<typeof enforceSqliteSessionHistoryDiskBudget>>;
  let hostQueries: string[];
  let hostStatementCalls: number;
  try {
    const calibration = new sqlite.DatabaseSync(":memory:");
    try {
      calibration.exec("CREATE TABLE calibration (value INTEGER)");
      calibration.prepare("INSERT INTO calibration VALUES (?)").run(1);
      const read = calibration.prepare("SELECT value FROM calibration");
      read.get();
      read.all();
      expect([...read.iterate()]).toHaveLength(1);
      expect(probes.every((probe) => probe.mock.calls.length > 0)).toBe(true);
    } finally {
      calibration.close();
      probes.forEach((probe) => probe.mockClear());
      executions.length = 0;
    }
    result = await own(
      enforceSqliteSessionHistoryDiskBudget({
        storePath: fixture.storePath,
        mode: "enforce",
        maintenance: { maxDiskBytes: highWaterBytes, highWaterBytes },
      }),
    );
  } finally {
    hostQueries = prepare.mock.calls.map(([sql]) => sql);
    hostStatementCalls = statements.reduce(
      (count, statement) => count + statement.mock.calls.length,
      0,
    );
    probes.forEach((probe) => probe.mockRestore());
  }
  expect(result).toMatchObject({ removedEntries: 0, removedFiles: 1 });
  expect(result?.totalBytesAfter).toBeLessThanOrEqual(highWaterBytes);
  expect(fixture.readArchive()).toBeUndefined();
  expect(fs.existsSync(fixture.archivePath)).toBe(false);
  expect(loadSessionEntryReadOnly(retained)?.sessionId).toBe("guard-retained");
  expect(hostQueries).toEqual([]);
  expect(hostStatementCalls).toBe(0);
  expect(executions).toEqual([]);
});

it("rejects another agent's archive without changing its canonical row or file", async () => {
  const fixture = await publishedArchive();
  const failure: unknown = await fixture
    .prune(0, { ...fixture.options, agentId: "other" })
    .catch((error: unknown) => error);
  expect(fixture.readArchive()).toEqual(fixture.originalArchive);
  expect(fs.readFileSync(fixture.archivePath)).toEqual(fixture.archivedBytes);
  const recovered = await fixture.prune(0);
  expect(recovered).toMatchObject({ removedFiles: 1, completed: true });
  expect(fixture.readArchive()).toBeUndefined();
  expect(fs.existsSync(fixture.archivePath)).toBe(false);
  expect(failure).toBeInstanceOf(Error);
  expect(String(failure)).toContain("main");
  expect(String(failure)).toContain("other");
});

it.each(["reader", "writer"] as const)(
  "native page reclamation defers without waiting for a pinned %s",
  (peerKind) => {
    const database = openOpenClawAgentDatabase({ agentId: "main", env: state.env });
    database.db.exec("PRAGMA wal_autocheckpoint = 0");
    database.db
      .prepare("INSERT INTO cache_entries(scope, key, blob, updated_at) VALUES (?, ?, ?, ?)")
      .run("checkpoint-proof", "padding", Buffer.alloc(4 * 1024 * 1024), 1);
    database.db.prepare("DELETE FROM cache_entries WHERE scope = ?").run("checkpoint-proof");
    expect(database.walMaintenance.checkpoint()).toBe(true);
    const busyTimeout = database.db.prepare("PRAGMA busy_timeout").get();
    const peer = realOpen(database.path, { readOnly: peerKind === "reader" });
    let restoreCheckpoint: (() => void) | undefined;
    try {
      if (peerKind === "reader") {
        peer.exec("BEGIN");
        peer.prepare("SELECT COUNT(*) FROM cache_entries").get();
        database.db
          .prepare("INSERT INTO cache_entries(scope, key, blob, updated_at) VALUES (?, ?, ?, ?)")
          .run("checkpoint-proof", "new-frame", Buffer.from("retained"), 2);
      } else {
        const prepare = database.db.prepare.bind(database.db);
        let checkpointObserved = false;
        const checkpoint = vi.spyOn(database.db, "prepare").mockImplementation((sql) => {
          const statement = prepare(sql);
          if (sql === "PRAGMA wal_checkpoint(TRUNCATE);" && !checkpointObserved) {
            const get = statement.get.bind(statement);
            statement.get = () => {
              const row = get();
              checkpointObserved = true;
              peer.exec("BEGIN IMMEDIATE");
              return row;
            };
          }
          return statement;
        });
        restoreCheckpoint = () => checkpoint.mockRestore();
      }
      const freePages = () =>
        Number(database.db.prepare("PRAGMA freelist_count").get()?.freelist_count);
      const before = freePages();
      expect(before).toBeGreaterThan(512);
      const startedAt = performance.now();
      const blocked = database.walMaintenance.reclaimFreePages();
      expect(performance.now() - startedAt).toBeLessThan(1_000);
      expect(peer.isTransaction).toBe(true);
      expect(freePages()).toBe(before);
      if (peerKind === "reader") {
        expect(blocked).toMatchObject({ checkpointCalls: 2, checkpointIncomplete: 1 });
      } else {
        expect(database.db.isTransaction).toBe(false);
      }
      expect(database.db.prepare("PRAGMA busy_timeout").get()).toEqual(busyTimeout);
      peer.exec("ROLLBACK");
      for (let remaining = freePages(); remaining > 0; remaining = freePages()) {
        database.walMaintenance.reclaimFreePages();
        expect(freePages()).toBeLessThan(remaining);
      }
      expect(freePages()).toBe(0);
      if (peerKind === "reader") {
        expect(
          database.db
            .prepare("SELECT blob FROM cache_entries WHERE scope = ? AND key = ?")
            .get("checkpoint-proof", "new-frame")?.blob,
        ).toEqual(new Uint8Array(Buffer.from("retained")));
        expect(database.walMaintenance.checkpoint()).toBe(true);
        expect(fs.statSync(database.path + "-wal").size).toBe(0);
      }
      expect(database.db.prepare("PRAGMA busy_timeout").get()).toEqual(busyTimeout);
    } finally {
      restoreCheckpoint?.();
      if (peer.isTransaction) {
        peer.exec("ROLLBACK");
      }
      peer.close();
    }
  },
);

it("bounds broker page reclamation and stops when its owner is revoked between units", async () => {
  const options = { agentId: "main", env: state.env };
  const database = openOpenClawAgentDatabase(options);
  database.db
    .prepare(
      "INSERT INTO cache_entries(scope, key, blob, updated_at) VALUES (?, ?, zeroblob(?), 1)",
    )
    .run("page-revocation", "padding", 4 * 1024 * 1024);
  database.db.prepare("DELETE FROM cache_entries WHERE scope = ?").run("page-revocation");
  database.walMaintenance.checkpoint();
  const before = Number(database.db.prepare("PRAGMA freelist_count").get()?.freelist_count);
  expect(before).toBeGreaterThan(512);
  await own(reclaimSqliteFreePages(options, undefined, { maxPages: 31 }));
  expect(before - Number(database.db.prepare("PRAGMA freelist_count").get()?.freelist_count)).toBe(
    31,
  );
  let remaining: number | null = null;
  const failure: unknown = await own(
    pageReclamation.withSqliteSessionPageReclamation(options, async (reclaim) => {
      const first = await reclaim(1);
      expect(first).toMatchObject({ checkpointCompleted: true, vacuumPagesRequested: 1 });
      remaining = first.remainingFreePages;
      expect(remaining).toBeGreaterThan(0);
      expect(remaining).toBeLessThan(before);
      closeOpenClawAgentDatabaseByPath(database.path);
      await expect(reclaim(1)).rejects.toThrow(/revoked|closed/);
    }),
  ).catch((error: unknown) => error);
  await closeOpenClawAgentDatabaseByPathAsync(database.path);
  const reopened = openOpenClawAgentDatabase(options);
  expect(Number(reopened.db.prepare("PRAGMA freelist_count").get()?.freelist_count)).toBe(
    remaining,
  );
  expect(failure).toMatchObject({
    code: "unavailable",
    message: expect.stringMatching(/revoked/),
  });
});

it.each([
  { phase: "read-result", outcome: "revoked" },
  { phase: "before-read", outcome: "unpublished" },
  { phase: "after-unlink", outcome: "complete" },
  { phase: "after-unlink", outcome: "revoked" },
  { phase: "after-unlink", outcome: "unpublished" },
  { phase: "after-unlink", outcome: "republished" },
] as const)("preserves item writer authority at $phase ($outcome)", async ({ phase, outcome }) => {
  const fixture = await publishedArchive();
  const entered = createDeferred();
  const release = createDeferred();
  releases.push(release.resolve);
  let held = false;
  let released = false;
  let laterWriterRan = false;
  const hold = async () => {
    if (held) {
      return;
    }
    held = true;
    entered.resolve();
    await release.promise;
  };
  const withPages = pageReclamation.withSqliteSessionPageReclamation;
  vi.spyOn(pageReclamation, "withSqliteSessionPageReclamation").mockImplementation(
    <T>(...args: Parameters<typeof withPages<T>>) => {
      const [input, run] = args;
      return withPages(input, (reclaim, assertCurrent, options, archives) =>
        run(reclaim, assertCurrent, options, {
          ...archives,
          read: async () => {
            if (!held && phase === "before-read") {
              await hold();
            }
            const result = await archives.read();
            if (!held && phase === "read-result") {
              await hold();
            }
            return result;
          },
        }),
      );
    },
  );
  const rm = fs.promises.rm.bind(fs.promises);
  vi.spyOn(fs.promises, "rm").mockImplementation(async (...args) => {
    const result = await rm(...args);
    if (phase === "after-unlink" && args[0] === fixture.archivePath) {
      await hold();
    }
    return result;
  });
  const work = fixture.prune();
  await withTestTimeout(
    entered.promise,
    10_000,
    "Archive operation did not reach its held boundary",
  );
  const later = own(
    runExclusiveSqliteSessionWrite(
      fixture.options,
      async () => {
        expect(released).toBe(true);
        laterWriterRan = true;
      },
      "session.transcript.batch",
    ),
  );
  let changedPublicationAt: number | null = null;
  if (outcome === "republished") {
    assert(fixture.originalArchive.published_at !== null);
    changedPublicationAt = fixture.originalArchive.published_at + 1;
  }
  if (outcome === "revoked") {
    closeOpenClawAgentDatabaseByPath(fixture.options.path);
  } else if (outcome === "unpublished" || outcome === "republished") {
    const peer = realOpen(fixture.options.path);
    try {
      executeSqliteQuerySync(
        peer,
        getSessionKysely(peer)
          .updateTable("session_transcript_archives")
          .set({ published_at: changedPublicationAt })
          .where("session_id", "=", fixture.sessionId),
      );
    } finally {
      peer.close();
    }
  }
  expect(laterWriterRan).toBe(false);
  released = true;
  release.resolve();
  let failure: unknown;
  const result = await work.catch((error: unknown) => {
    failure = error;
    return undefined;
  });
  await later;
  expect(laterWriterRan).toBe(true);
  if (outcome === "revoked") {
    await closeOpenClawAgentDatabaseByPathAsync(fixture.options.path);
  }
  const row = fixture.readArchive();
  if (outcome === "complete") {
    expect(row).toBeUndefined();
    expect(fs.existsSync(fixture.archivePath)).toBe(false);
    expect(failure).toBeUndefined();
    expect(result).toMatchObject({ removedFiles: 1 });
  } else {
    expect(row).toEqual({
      ...fixture.originalArchive,
      ...(outcome === "unpublished" || outcome === "republished"
        ? { published_at: changedPublicationAt }
        : {}),
    });
    if (phase === "after-unlink") {
      expect(fs.existsSync(fixture.archivePath)).toBe(false);
    } else {
      expect(fs.readFileSync(fixture.archivePath)).toEqual(fixture.archivedBytes);
    }
    if (outcome === "revoked") {
      expect(failure).toBeInstanceOf(Error);
      expect(String(failure)).toMatch(/revoked|closed/);
    } else if (phase === "after-unlink") {
      expect(String(failure)).toContain(
        "SQLite session archive changed during pruning; retry cleanup.",
      );
    } else {
      expect(failure).toBeUndefined();
      expect(result).toMatchObject({ removedFiles: 0 });
    }
  }
});

it("preserves an unpublished canonical archive whose owner appears after legacy inventory", async () => {
  const fixture = await publishedArchive();
  const { archivePath, archivedBytes, sessionId, originalArchive } = fixture;
  const sessionsDir = path.dirname(archivePath);
  const archiveName = path.basename(archivePath);
  const database = openOpenClawAgentDatabase(fixture.options);
  const db = getSessionKysely(database.db);
  executeSqliteQuerySync(
    database.db,
    db.deleteFrom("session_transcript_archives").where("session_id", "=", sessionId),
  );
  const canonicalArchive = {
    ...originalArchive,
    published_at: null,
  };
  let readingLegacyInventory = false;
  let inserted = false;
  const pruneLegacy = diskBudget.pruneSessionTranscriptArchivesToHighWater;
  vi.spyOn(diskBudget, "pruneSessionTranscriptArchivesToHighWater").mockImplementation(
    async (params) => {
      expect(
        executeSqliteQuerySync(
          database.db,
          db
            .selectFrom("session_transcript_archives")
            .select("archive_name")
            .where("archive_name", "=", archiveName),
        ).rows,
      ).toEqual([]);
      readingLegacyInventory = true;
      try {
        return await pruneLegacy(params);
      } finally {
        readingLegacyInventory = false;
      }
    },
  );
  const readFiles = diskBudgetFiles.readSessionsDirFiles;
  vi.spyOn(diskBudgetFiles, "readSessionsDirFiles").mockImplementation(async (...args) => {
    const files = await readFiles(...args);
    if (readingLegacyInventory && !inserted && args[0] === sessionsDir) {
      expect(files.some((file) => file.path === archivePath)).toBe(true);
      const peer = realOpen(database.path);
      try {
        executeSqliteQuerySync(
          peer,
          getSessionKysely(peer).insertInto("session_transcript_archives").values(canonicalArchive),
        );
        inserted = true;
      } finally {
        peer.close();
      }
    }
    return files;
  });
  const result = await fixture.prune();
  expect(inserted).toBe(true);
  expect(fixture.readArchive()).toEqual(canonicalArchive);
  expect(fs.existsSync(archivePath)).toBe(true);
  expect(fs.readFileSync(archivePath)).toEqual(archivedBytes);
  expect(result.removedFiles).toBe(0);
});

it("excludes peer publication until atomic legacy removal settles", async () => {
  const fixture = await publishedArchive();
  const database = openOpenClawAgentDatabase(fixture.options);
  executeSqliteQuerySync(
    database.db,
    getSessionKysely(database.db)
      .deleteFrom("session_transcript_archives")
      .where("session_id", "=", fixture.sessionId),
  );
  const peer = realOpen(fixture.options.path);
  peer.exec("PRAGMA busy_timeout = 0;");
  let removing: string | undefined;
  let physicalPath: string | undefined;
  let attempted = false;
  let filePresentAtGrant = false;
  let peerEntered = false;
  let refusal: unknown;
  const withPages = pageReclamation.withSqliteSessionPageReclamation;
  vi.spyOn(pageReclamation, "withSqliteSessionPageReclamation").mockImplementation(
    <T>(...args: Parameters<typeof withPages<T>>) => {
      const [input, run] = args;
      return withPages(input, (reclaim, assertCurrent, options, archives) => {
        physicalPath = options.path;
        return run(reclaim, assertCurrent, options, {
          ...archives,
          removeLegacy: async (filePath) => {
            removing = filePath;
            try {
              return await archives.removeLegacy(filePath);
            } finally {
              removing = undefined;
            }
          },
        });
      });
    },
  );
  workerProbe.admission(workerAdmission, (request, grant, admit) => {
    if (
      !attempted &&
      removing === fixture.archivePath &&
      request.stage === "commit" &&
      isRecord(request.facts) &&
      isRecord(request.facts.identity) &&
      request.facts.identity.nativeLocation === physicalPath
    ) {
      attempted = true;
      filePresentAtGrant = fs.existsSync(fixture.archivePath);
      try {
        peer.exec("BEGIN IMMEDIATE");
        peerEntered = true;
      } catch (error) {
        refusal = error;
      } finally {
        if (peer.isTransaction) {
          peer.exec("ROLLBACK");
        }
      }
    }
    admit(request, grant);
  });
  let work: ReturnType<typeof pruneAllSessionTranscriptArchivesToHighWater> | undefined;
  try {
    work = fixture.prune();
    const result = await work;
    expect(fixture.readArchive()).toBeUndefined();
    expect(fs.existsSync(fixture.archivePath)).toBe(false);
    expect(result.removedFiles).toBe(1);
    expect(attempted).toBe(true);
    expect(filePresentAtGrant).toBe(true);
    expect(peerEntered).toBe(false);
    expect(refusal).toMatchObject({ errcode: 5 });
    assert(fixture.originalArchive.published_at !== null);
    fs.writeFileSync(fixture.archivePath, fixture.archivedBytes);
    peer.exec("BEGIN IMMEDIATE");
    executeSqliteQuerySync(
      peer,
      getSessionKysely(peer)
        .insertInto("session_transcript_archives")
        .values(fixture.originalArchive),
    );
    peer.exec("COMMIT");
    expect(fixture.readArchive()).toEqual(fixture.originalArchive);
    expect(fs.readFileSync(fixture.archivePath)).toEqual(fixture.archivedBytes);
  } finally {
    if (peer.isTransaction) {
      peer.exec("ROLLBACK");
    }
    await Promise.allSettled([work]);
    peer.close();
  }
});
