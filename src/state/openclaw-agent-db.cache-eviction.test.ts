// Agent database cache tests cover idle process-local SQLite handle ownership.
import fs from "node:fs";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as nodeSqlite from "../infra/node-sqlite.js";
import { SQLITE_IDLE_HANDLE_TTL_MS } from "../infra/sqlite-handle-lifecycle.js";
import { createDeferredCore } from "../shared/deferred.js";
import { retainOpenClawAgentDatabaseReadOnly } from "./openclaw-agent-db-readonly.js";
import {
  borrowOpenClawAgentDatabase,
  clearOpenClawAgentDatabaseOpenFailure,
  closeOpenClawAgentDatabaseByPath,
  closeOpenClawAgentDatabasesForTest,
  disposeOpenClawAgentDatabaseByPath,
  isOpenClawAgentDatabaseOpen,
  listOpenClawRegisteredAgentDatabases,
  openOpenClawAgentDatabase,
  recordOpenClawAgentDatabaseOpenFailure,
  resolveIncognitoOpenClawAgentSqlitePath,
  runOpenClawAgentWriteTransaction,
  withOpenClawAgentDatabaseAsync,
} from "./openclaw-agent-db.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "./openclaw-state-db.js";

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

describe("openclaw agent database handle cache", () => {
  it("opens each agent once across repeated operations with more than 64 active stores", () => {
    const open = vi.spyOn(nodeSqlite, "openNodeSqliteDatabase");
    const agents = Array.from({ length: 65 }, (_, index) => `fixture-${index}`);
    for (let round = 0; round < 3; round++) {
      for (const agentId of agents) {
        expect(
          openOpenClawAgentDatabase({ agentId, env }).db.prepare("SELECT 1 AS value").get(),
        ).toEqual({ value: 1 });
      }
    }
    expect(
      open.mock.calls.filter(([pathname]) => pathname.endsWith("openclaw-agent.sqlite")),
    ).toHaveLength(agents.length);
    const first = openOpenClawAgentDatabase({ agentId: agents[0]!, env });
    vi.advanceTimersByTime(SQLITE_IDLE_HANDLE_TTL_MS - 1);
    expect(first.db.isOpen).toBe(true);
    vi.advanceTimersByTime(1);
    expect(first.db.isOpen).toBe(false);
    expect(isOpenClawAgentDatabaseOpen(first.path)).toBe(false);
  });

  it("starts another complete idle window when an existing handle is used", () => {
    const options = { agentId: "activity", env };
    const database = openOpenClawAgentDatabase(options);
    vi.advanceTimersByTime(SQLITE_IDLE_HANDLE_TTL_MS - 1);
    expect(openOpenClawAgentDatabase(options)).toBe(database);
    vi.advanceTimersByTime(SQLITE_IDLE_HANDLE_TTL_MS - 1);
    expect(database.db.isOpen).toBe(true);
    vi.advanceTimersByTime(1);
    expect(database.db.isOpen).toBe(false);
  });

  it("does not count periodic WAL maintenance as database activity", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    const database = openOpenClawAgentDatabase({ agentId: "idle-maintenance", env });
    await vi.advanceTimersByTimeAsync(SQLITE_IDLE_HANDLE_TTL_MS);
    expect(database.db.isOpen).toBe(false);
  });

  it("keeps incognito state until explicit close because its connection owns the data", () => {
    const options = { agentId: "incognito-idle", env };
    const incognito = { ...options, path: resolveIncognitoOpenClawAgentSqlitePath(options) };
    const database = openOpenClawAgentDatabase(incognito);
    database.db
      .prepare(
        "INSERT INTO auth_profile_state (state_key, state_json, updated_at) VALUES (?, ?, ?)",
      )
      .run("retained", "{}", 42);
    vi.advanceTimersByTime(SQLITE_IDLE_HANDLE_TTL_MS * 2);
    expect(openOpenClawAgentDatabase(incognito)).toBe(database);
    expect(
      database.db
        .prepare("SELECT updated_at FROM auth_profile_state WHERE state_key = ?")
        .get("retained"),
    ).toEqual({ updated_at: 42 });
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

  it.each([false, true])(
    "starts the idle window after a cached operation settles (throws=%s)",
    async (throws) => {
      const options = { agentId: "cached-operation", env };
      const target = openOpenClawAgentDatabase(options);
      const entered = createDeferredCore();
      const proceed = createDeferredCore();
      const result = withOpenClawAgentDatabaseAsync(options, async (database) => {
        entered.resolve();
        await proceed.promise;
        expect(database).toBe(target);
        expect(database.db.isOpen).toBe(true);
        if (throws) {
          throw new Error("synthetic operation failure");
        }
        return database.agentId;
      });
      const settled = throws
        ? expect(result).rejects.toThrow("synthetic operation failure")
        : expect(result).resolves.toBe(target.agentId);
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
    },
  );

  it("does not invoke an admitted operation after explicit disposal revokes its handle", async () => {
    const target = openOpenClawAgentDatabase({ agentId: "revoked-operation", env });
    const operation = vi.fn();
    const result = withOpenClawAgentDatabaseAsync({ agentId: target.agentId, env }, operation);
    closeOpenClawAgentDatabaseByPath(target.path);
    await expect(result).rejects.toThrow(/closed|revoked/);
    expect(operation).not.toHaveBeenCalled();
  });

  it("releases an evicted lease in its acquisition store after its environment changes", () => {
    const mutableEnv = { ...env };
    const nextStateDir = tempDirs.make("agent-lease-eviction-");
    const database = openOpenClawAgentDatabase({ agentId: "lease-environment", env: mutableEnv });
    mutableEnv.OPENCLAW_STATE_DIR = nextStateDir;
    vi.advanceTimersByTime(SQLITE_IDLE_HANDLE_TTL_MS);
    expect(database.db.isOpen).toBe(false);
    const { db } = openOpenClawStateDatabase({ env });
    expect(
      db.prepare("SELECT lease_id FROM agent_database_leases WHERE path = ?").all(database.path),
    ).toEqual([]);
    expect(fs.readdirSync(nextStateDir)).toEqual([]);
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

  it("reopens an evicted database, revalidates schema, and preserves durable rows and discovery", () => {
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

  it("validates ownership when an evicted path is requested for another agent", () => {
    const evicted = openOpenClawAgentDatabase({ agentId: "worker-a", env });
    vi.advanceTimersByTime(SQLITE_IDLE_HANDLE_TTL_MS);
    expect(evicted.db.isOpen).toBe(false);
    expect(() =>
      openOpenClawAgentDatabase({ agentId: "worker-b", env, path: evicted.path }),
    ).toThrow(/belongs to agent worker-a/);
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

  it("removes discovery on explicit disposal and registers a new admission", () => {
    const options = { agentId: "disposed", env };
    const database = openOpenClawAgentDatabase(options);
    expect(disposeOpenClawAgentDatabaseByPath(database.path, { env })).toBe(true);
    expect(database.db.isOpen).toBe(false);
    expect(
      listOpenClawRegisteredAgentDatabases({ env }).some((entry) => entry.path === database.path),
    ).toBe(false);
    expect(openOpenClawAgentDatabase(options)).not.toBe(database);
    expect(
      listOpenClawRegisteredAgentDatabases({ env }).some((entry) => entry.path === database.path),
    ).toBe(true);
  });
});
