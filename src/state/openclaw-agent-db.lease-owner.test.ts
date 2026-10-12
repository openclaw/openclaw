import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTempDirTracker, useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as nodeSqlite from "../infra/node-sqlite.js";
import { revokeSqliteDatabaseAdmissionsForPath } from "../infra/sqlite-database-admission.js";
import { SQLITE_IDLE_HANDLE_TTL_MS } from "../infra/sqlite-handle-lifecycle.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  assertNoOpenClawAgentDatabaseLeasesReadOnly,
  readActiveOpenClawAgentDatabaseLeasesReadOnly,
} from "./openclaw-agent-db-lease.js";
import { retainOpenClawAgentDatabaseReadOnly } from "./openclaw-agent-db-readonly.js";
import {
  borrowOpenClawAgentDatabase,
  clearOpenClawAgentDatabaseOpenFailure,
  closeOpenClawAgentDatabaseByPath,
  closeOpenClawAgentDatabasesForTest,
  getOpenClawAgentDatabaseIfOpen,
  listOpenClawRegisteredAgentDatabases,
  openOpenClawAgentDatabase,
  recordOpenClawAgentDatabaseOpenFailure,
  settleOpenClawAgentDatabaseWorkerClose,
  withOpenClawAgentDatabaseAdmission,
  withOpenClawAgentDatabaseAsync,
  runOpenClawAgentWriteTransaction,
  type OpenClawAgentDatabaseWriteAdmission,
} from "./openclaw-agent-db.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "./openclaw-state-db.js";
import { claimOpenClawStateOwnership } from "./openclaw-state-ownership-operations.js";

describe("agent database lease acquisition owner", () => {
  const tempDirs = createTempDirTracker();
  const connections: DatabaseSync[] = [];
  const admitted: OpenClawAgentDatabaseWriteAdmission = async (run) => run(() => {});

  afterEach(() => {
    vi.restoreAllMocks();
    closeOpenClawAgentDatabasesForTest();
    for (const connection of connections.splice(0)) {
      if (connection.isOpen) {
        connection.close();
      }
    }
    closeOpenClawStateDatabaseForTest();
    vi.unstubAllEnvs();
    tempDirs.cleanup();
  });

  function createOwner() {
    const stateDir = tempDirs.make("agent-lease-owner-");
    const nextStateDir = tempDirs.make("agent-lease-next-");
    const env: NodeJS.ProcessEnv = { OPENCLAW_STATE_DIR: stateDir };
    const state = openOpenClawStateDatabase({ env });
    const leases = () => state.db.prepare("SELECT lease_id FROM agent_database_leases").all();
    return { stateDir, nextStateDir, env, leases };
  }

  it.each([true, false])("observes live leases before maintenance (cached: %s)", (cached) => {
    const { env } = createOwner();
    const agent = openOpenClawAgentDatabase({ agentId: "main", env });
    if (!cached) {
      closeOpenClawStateDatabaseForTest();
    }

    expect(readActiveOpenClawAgentDatabaseLeasesReadOnly({ env })).toEqual([
      expect.objectContaining({ agent_id: "main", path: agent.path, owner_pid: process.pid }),
    ]);
    expect(() => assertNoOpenClawAgentDatabaseLeasesReadOnly({ env })).toThrow(
      "database is still open in process",
    );

    expect(closeOpenClawAgentDatabaseByPath(agent.path)).toBe(true);
    if (!cached) {
      closeOpenClawStateDatabaseForTest();
    }
    expect(readActiveOpenClawAgentDatabaseLeasesReadOnly({ env })).toEqual([]);
    expect(() => assertNoOpenClawAgentDatabaseLeasesReadOnly({ env })).not.toThrow();
  });

  it("rejects initial authority denial without creating a database or changing its directory", async () => {
    const owner = createOwner();
    const directory = path.join(owner.stateDir, "custom");
    fs.mkdirSync(directory);
    fs.chmodSync(directory, 0o750);
    const mode = fs.statSync(directory).mode;
    const options = {
      agentId: "worker",
      env: owner.env,
      path: path.join(directory, "agent.sqlite"),
    };
    const denied = new Error("synthetic write authority revoked");
    const operation = vi.fn();

    await expect(
      withOpenClawAgentDatabaseAdmission(
        options,
        async (run) =>
          run(() => {
            throw denied;
          }),
        operation,
      ),
    ).rejects.toBe(denied);

    expect(operation).not.toHaveBeenCalled();
    expect(fs.readdirSync(directory)).toEqual([]);
    expect(fs.statSync(directory).mode).toBe(mode);
    expect(owner.leases()).toEqual([]);
    expect(getOpenClawAgentDatabaseIfOpen(options)).toBeUndefined();
    await expect(
      withOpenClawAgentDatabaseAdmission(options, admitted, (database) => database.agentId),
    ).resolves.toBe(options.agentId);
  });

  it("unwinds an unfinished physical open when the scheduler rejects the next permit", async () => {
    const owner = createOwner();
    const options = { agentId: "worker", env: owner.env };
    const original = openOpenClawAgentDatabase(options);
    original.db.exec(`
      INSERT INTO cache_entries (scope,key,value_json,expires_at,updated_at)
        VALUES ('admission','retained','{"retained":true}',100,1);
      DROP INDEX idx_agent_cache_expiry;
    `);
    expect(closeOpenClawAgentDatabaseByPath(original.path)).toBe(true);
    closeOpenClawAgentDatabasesForTest(owner.stateDir);
    revokeSqliteDatabaseAdmissionsForPath(original.path);
    const nativeOpen = nodeSqlite.openNodeSqliteDatabase;
    let opened: DatabaseSync | undefined;
    const open = vi
      .spyOn(nodeSqlite, "openNodeSqliteDatabase")
      .mockImplementation((location, config) => {
        const connection = nativeOpen(location, config);
        if (location === original.path) {
          opened = connection;
          connections.push(connection);
        }
        return connection;
      });
    const lostScheduler = new Error("synthetic parent closed during database admission");
    let permits = 0;
    const withAdmission: OpenClawAgentDatabaseWriteAdmission = async (run) => {
      if (++permits === 2) {
        expect(owner.leases()).toHaveLength(1);
        expect(opened?.isOpen).toBe(true);
        throw lostScheduler;
      }
      return run(() => {});
    };
    const operation = vi.fn();

    await expect(
      withOpenClawAgentDatabaseAdmission(options, withAdmission, operation),
    ).rejects.toBe(lostScheduler);

    expect(permits).toBe(2);
    expect(operation).not.toHaveBeenCalled();
    expect(opened?.isOpen).toBe(false);
    expect(getOpenClawAgentDatabaseIfOpen(options)).toBeUndefined();
    expect(owner.leases()).toEqual([]);
    open.mockRestore();
    const retained = nativeOpen(original.path, { readOnly: true });
    try {
      expect(
        retained.prepare("SELECT sql FROM sqlite_schema WHERE name='idx_agent_cache_expiry'").get(),
      ).toBeUndefined();
      expect(retained.prepare("SELECT * FROM cache_entries").all()).toEqual([
        {
          scope: "admission",
          key: "retained",
          value_json: '{"retained":true}',
          blob: null,
          expires_at: 100,
          updated_at: 1,
        },
      ]);
    } finally {
      retained.close();
    }
    await expect(
      withOpenClawAgentDatabaseAdmission(options, admitted, (database) => database.agentId),
    ).resolves.toBe(options.agentId);
  });

  it("resets a recreated fixture root without retiring another root", () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
    const owner = createOwner();
    const env = owner.env;
    const otherEnv = { OPENCLAW_STATE_DIR: owner.nextStateDir };
    const closed = openOpenClawAgentDatabase({ agentId: "closed", env });
    closeOpenClawAgentDatabaseByPath(closed.path);
    const active = openOpenClawAgentDatabase({ agentId: "active", env });
    const other = openOpenClawAgentDatabase({ agentId: "other", env: otherEnv });
    const failedPath = path.join(owner.stateDir, "failed.sqlite");
    const otherFailedPath = path.join(owner.nextStateDir, "failed.sqlite");
    const failure = new Error("fixture open failure");
    recordOpenClawAgentDatabaseOpenFailure(failedPath, failure);
    recordOpenClawAgentDatabaseOpenFailure(otherFailedPath, failure);

    closeOpenClawAgentDatabasesForTest(owner.stateDir);

    expect(active.db.isOpen).toBe(false);
    expect(owner.leases()).toEqual([]);
    expect(other.db.isOpen).toBe(true);
    expect(openOpenClawAgentDatabase({ agentId: "other", env: otherEnv })).toBe(other);
    expect(() =>
      openOpenClawAgentDatabase({ agentId: "failed", env: otherEnv, path: otherFailedPath }),
    ).toThrow(failure);
    expect(openOpenClawAgentDatabase({ agentId: "failed", env, path: failedPath }).db.isOpen).toBe(
      true,
    );

    now.mockReturnValue(2_000);
    openOpenClawAgentDatabase({ agentId: closed.agentId, env });
    expect(
      listOpenClawRegisteredAgentDatabases({ env }).find((entry) => entry.path === closed.path),
    ).toMatchObject({ lastSeenAt: 2_000 });
  });

  it.each([
    { kind: "ambient environment", ambient: true, external: false, worker: false },
    { kind: "removed external supervision marker", ambient: false, external: true, worker: false },
    {
      kind: "Worker settlement after environment mutation",
      ambient: false,
      external: false,
      worker: true,
    },
  ])("releases the original lease with $kind", ({ ambient, external, worker }) => {
    const owner = createOwner();
    if (external) {
      owner.env.OPENCLAW_SUPERVISOR_MODE = "external";
      claimOpenClawStateOwnership("fixture-supervisor", { env: owner.env });
    }
    vi.stubEnv("OPENCLAW_STATE_DIR", owner.stateDir);
    vi.stubEnv("OPENCLAW_AGENT_DIR", undefined);
    const database = openOpenClawAgentDatabase({
      agentId: "main",
      ...(ambient ? {} : { env: owner.env }),
    });
    expect(owner.leases()).toHaveLength(1);
    try {
      if (external) {
        delete owner.env.OPENCLAW_SUPERVISOR_MODE;
      } else {
        owner.env.OPENCLAW_STATE_DIR = owner.nextStateDir;
        vi.stubEnv("OPENCLAW_STATE_DIR", owner.nextStateDir);
      }
      expect(fs.readdirSync(owner.nextStateDir)).toEqual([]);
      if (worker) {
        expect(settleOpenClawAgentDatabaseWorkerClose(database.path)).toEqual({
          errors: [],
          settled: true,
        });
      } else if (ambient) {
        closeOpenClawAgentDatabasesForTest();
      } else {
        expect(closeOpenClawAgentDatabaseByPath(database.path)).toBe(true);
      }
      expect(database.db.isOpen).toBe(false);
      expect(owner.leases()).toEqual([]);
      expect(fs.readdirSync(owner.nextStateDir)).toEqual([]);
    } finally {
      owner.env.OPENCLAW_STATE_DIR = owner.stateDir;
      if (external) {
        owner.env.OPENCLAW_SUPERVISOR_MODE = "external";
      }
      vi.stubEnv("OPENCLAW_STATE_DIR", owner.stateDir);
    }
  });

  it("releases a retained failed-open handle in its original store", () => {
    const owner = createOwner();
    const database = openOpenClawAgentDatabase({ agentId: "main", env: owner.env });
    expect(closeOpenClawAgentDatabaseByPath(database.path)).toBe(true);
    const nativeOpen = nodeSqlite.openNodeSqliteDatabase;
    const open = vi
      .spyOn(nodeSqlite, "openNodeSqliteDatabase")
      .mockImplementation((location, options) => {
        const connection = nativeOpen(location, options);
        if (location === database.path) {
          open.mockRestore();
          vi.spyOn(connection, "close").mockImplementationOnce(() => {
            // Change the caller's environment after claim, during failed-open cleanup.
            owner.env.OPENCLAW_STATE_DIR = owner.nextStateDir;
            throw new Error("fixture close failure");
          });
        }
        return connection;
      });
    try {
      expect(() =>
        openOpenClawAgentDatabase({ agentId: "other", env: owner.env, path: database.path }),
      ).toThrow("fixture close failure");
      open.mockRestore();
      expect(owner.leases()).toHaveLength(1);
      expect(closeOpenClawAgentDatabaseByPath(database.path)).toBe(true);
      expect(owner.leases()).toEqual([]);
      expect(fs.readdirSync(owner.nextStateDir)).toEqual([]);
    } finally {
      open.mockRestore();
      owner.env.OPENCLAW_STATE_DIR = owner.stateDir;
    }
  });
});

describe("openclaw agent database handle cache", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterAll);
  let env: NodeJS.ProcessEnv;

  beforeAll(() => {
    env = { OPENCLAW_STATE_DIR: fs.realpathSync(tempDirs.make("openclaw-agent-db-cache-")) };
  });

  beforeEach(() => {
    closeOpenClawAgentDatabasesForTest();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  });

  afterEach(() => {
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("does not count periodic WAL maintenance as database activity", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    const database = openOpenClawAgentDatabase({ agentId: "idle-maintenance", env });
    await vi.advanceTimersByTimeAsync(SQLITE_IDLE_HANDLE_TTL_MS);
    expect(database.db.isOpen).toBe(false);
  });

  it("retains concurrent admissions through the transaction's borrower handoff", async () => {
    const entered = createDeferredCore();
    const proceed = createDeferredCore();
    const transferred: ReturnType<typeof borrowOpenClawAgentDatabase>[] = [];
    let operations = 0;
    const admitted = ["adoption-first", "adoption-second"].map((agentId) => {
      const options = { agentId, env };
      return withOpenClawAgentDatabaseAsync(options, async (database) => {
        if (++operations === 2) {
          entered.resolve();
        }
        await proceed.promise;
        return runOpenClawAgentWriteTransaction((current) => {
          expect(current.db).toBe(database.db);
          transferred.push(borrowOpenClawAgentDatabase(options));
          return database;
        }, options);
      });
    });
    const finished = Promise.all(admitted);
    try {
      await Promise.race([entered.promise, finished]);
      vi.advanceTimersByTime(SQLITE_IDLE_HANDLE_TTL_MS);
      proceed.resolve();
      const databases = await finished;
      vi.advanceTimersByTime(SQLITE_IDLE_HANDLE_TTL_MS);
      expect(databases.every((database) => database.db.isOpen)).toBe(true);
      for (const borrowed of transferred) {
        borrowed.release();
      }
      vi.advanceTimersByTime(SQLITE_IDLE_HANDLE_TTL_MS - 1);
      expect(databases.every((database) => database.db.isOpen)).toBe(true);
      vi.advanceTimersByTime(1);
      expect(databases.every((database) => !database.db.isOpen)).toBe(true);
    } finally {
      proceed.resolve();
      await Promise.allSettled(admitted);
      for (const borrowed of transferred) {
        borrowed.release();
      }
    }
  });

  it("starts the idle window after a cached operation rejects", async () => {
    const options = { agentId: "cached-operation", env };
    const target = openOpenClawAgentDatabase(options);
    const entered = createDeferredCore();
    const proceed = createDeferredCore();
    const result = withOpenClawAgentDatabaseAsync(options, async (database) => {
      entered.resolve();
      await proceed.promise;
      expect(database).toBe(target);
      expect(database.db.isOpen).toBe(true);
      throw new Error("synthetic operation failure");
    });
    const settled = expect(result).rejects.toThrow("synthetic operation failure");
    try {
      await entered.promise;
      vi.advanceTimersByTime(SQLITE_IDLE_HANDLE_TTL_MS * 2);
      expect(target.db.isOpen).toBe(true);
      proceed.resolve();
      await settled;
      vi.advanceTimersByTime(SQLITE_IDLE_HANDLE_TTL_MS - 1);
      expect(target.db.isOpen).toBe(true);
      vi.advanceTimersByTime(1);
      expect(target.db.isOpen).toBe(false);
    } finally {
      proceed.resolve();
      await Promise.allSettled([result]);
    }
  });

  it("does not invoke an admitted operation after explicit disposal revokes its handle", async () => {
    const target = openOpenClawAgentDatabase({ agentId: "revoked-operation", env });
    const operation = vi.fn();
    const result = withOpenClawAgentDatabaseAsync({ agentId: target.agentId, env }, operation);
    closeOpenClawAgentDatabaseByPath(target.path);
    await expect(result).rejects.toThrow(/closed|revoked/);
    expect(operation).not.toHaveBeenCalled();
  });

  it("keeps an open transaction through expiry and evicts after it finishes", () => {
    const database = openOpenClawAgentDatabase({ agentId: "transaction", env });
    database.db.exec("BEGIN IMMEDIATE");
    try {
      vi.advanceTimersByTime(SQLITE_IDLE_HANDLE_TTL_MS);
      expect(database.db.isOpen).toBe(true);
      expect(database.db.isTransaction).toBe(true);
    } finally {
      database.db.exec("ROLLBACK");
    }
    vi.advanceTimersByTime(SQLITE_IDLE_HANDLE_TTL_MS);
    expect(database.db.isOpen).toBe(false);
  });

  it("pins a completion's exact database until its final claim is released", () => {
    const options = { agentId: "completion", env };
    const database = openOpenClawAgentDatabase(options);
    const retained = retainOpenClawAgentDatabaseReadOnly(options);
    if (!retained.found) {
      throw new Error("expected the cached database");
    }
    try {
      vi.advanceTimersByTime(SQLITE_IDLE_HANDLE_TTL_MS);
      expect(retained.claim.isCurrent()).toBe(true);
      expect(database.db.isOpen).toBe(true);
      retained.claim.release();
      vi.advanceTimersByTime(SQLITE_IDLE_HANDLE_TTL_MS - 1);
      expect(database.db.isOpen).toBe(true);
      vi.advanceTimersByTime(1);
      expect(database.db.isOpen).toBe(false);
      expect(retained.claim.isCurrent()).toBe(false);
    } finally {
      retained.claim.release();
    }
  });

  it("retries failed lease cleanup without retaining a closed handle forever", () => {
    const database = openOpenClawAgentDatabase({ agentId: "lease-retry", env });
    const { db: state } = openOpenClawStateDatabase({ env });
    state.exec(`CREATE TEMP TRIGGER fail_agent_lease_release BEFORE DELETE ON agent_database_leases
      BEGIN SELECT RAISE(ABORT, 'blocked lease release'); END`);
    try {
      expect(() => closeOpenClawAgentDatabaseByPath(database.path)).toThrow(
        "blocked lease release",
      );
      expect(database.db.isOpen).toBe(false);
      state.exec("DROP TRIGGER fail_agent_lease_release");
      vi.advanceTimersByTime(SQLITE_IDLE_HANDLE_TTL_MS);
      const current = openOpenClawStateDatabase({ env });
      expect(
        current.db
          .prepare("SELECT lease_id FROM agent_database_leases WHERE agent_id = ?")
          .all(database.agentId),
      ).toEqual([]);
    } finally {
      if (state.isOpen) {
        state.exec("DROP TRIGGER IF EXISTS fail_agent_lease_release");
      }
      closeOpenClawAgentDatabaseByPath(database.path);
    }
  });

  it("reuses an evicted database and repairs a replacement while preserving rows and discovery", () => {
    const options = { agentId: "durability", env };
    const evicted = openOpenClawAgentDatabase(options);
    evicted.db
      .prepare(
        "INSERT INTO auth_profile_state (state_key, state_json, updated_at) VALUES (?, ?, ?)",
      )
      .run("cache-eviction", JSON.stringify({ preserved: true }), 42);
    const registration = listOpenClawRegisteredAgentDatabases({ env }).find(
      (entry) => entry.path === evicted.path,
    );
    expect(registration).toBeDefined();
    vi.advanceTimersByTime(SQLITE_IDLE_HANDLE_TTL_MS);
    expect(evicted.db.isOpen).toBe(false);
    const cachedReopen = openOpenClawAgentDatabase(options);
    expect(cachedReopen).not.toBe(evicted);
    expect(
      listOpenClawRegisteredAgentDatabases({ env }).find((entry) => entry.path === evicted.path),
    ).toEqual(registration);
    vi.advanceTimersByTime(SQLITE_IDLE_HANDLE_TTL_MS);
    expect(cachedReopen.db.isOpen).toBe(false);
    fs.copyFileSync(evicted.path, `${evicted.path}.replacement`);
    fs.renameSync(`${evicted.path}.replacement`, evicted.path);
    const divergent = new (nodeSqlite.requireNodeSqlite().DatabaseSync)(evicted.path);
    try {
      divergent.exec("ALTER TABLE session_nodes DROP COLUMN project_id;");
    } finally {
      divergent.close();
    }
    const reopened = openOpenClawAgentDatabase(options);
    expect(reopened).not.toBe(cachedReopen);
    expect(
      reopened.db
        .prepare("PRAGMA table_info(session_nodes)")
        .all()
        .some((row) => row.name === "project_id"),
    ).toBe(true);
    expect(
      reopened.db
        .prepare("SELECT state_json, updated_at FROM auth_profile_state WHERE state_key = ?")
        .get("cache-eviction"),
    ).toEqual({ state_json: JSON.stringify({ preserved: true }), updated_at: 42 });
    expect(
      listOpenClawRegisteredAgentDatabases({ env }).find((entry) => entry.path === evicted.path),
    ).toMatchObject({
      agentId: options.agentId,
      path: evicted.path,
      schemaVersion: registration!.schemaVersion,
    });
  });

  it("revokes on quarantine and opens a new native handle after quarantine is cleared", () => {
    const options = { agentId: "quarantine", env };
    const database = openOpenClawAgentDatabase(options);
    const open = vi.spyOn(nodeSqlite, "openNodeSqliteDatabase");
    const error = new Error("synthetic quarantine");
    expect(recordOpenClawAgentDatabaseOpenFailure(database.path, error)).toBe(true);
    expect(database.db.isOpen).toBe(false);
    expect(() => openOpenClawAgentDatabase(options)).toThrow(error);
    clearOpenClawAgentDatabaseOpenFailure(database.path, { env });
    expect(openOpenClawAgentDatabase(options).db.isOpen).toBe(true);
    expect(open.mock.calls.filter(([pathname]) => pathname === database.path)).toHaveLength(1);
  });
});
