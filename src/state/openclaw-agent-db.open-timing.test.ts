import { performance } from "node:perf_hooks";
import { isMainThread, threadId } from "node:worker_threads";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanupTempDirs, makeTempDir } from "../../test/helpers/temp-dir.js";
import * as sqlite from "../infra/node-sqlite.js";
import { revokeSqliteDatabaseAdmissionsForPath } from "../infra/sqlite-database-admission.js";
import * as integrityWorker from "../infra/sqlite-integrity-worker.js";
import * as wal from "../infra/sqlite-wal.js";
import { createDeferredCore } from "../shared/deferred.js";
import * as permissions from "./openclaw-agent-db-permissions.js";
import * as registry from "./openclaw-agent-db-registry.js";
import * as schema from "./openclaw-agent-db-schema.js";
import {
  closeOpenClawAgentDatabaseByPath,
  closeOpenClawAgentDatabasesForTest,
  closeOpenClawAgentDatabasesAsync,
  openOpenClawAgentDatabase,
  withOpenClawAgentDatabaseAsync,
  resolveOpenClawAgentSqlitePath,
} from "./openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "./openclaw-state-db.js";

const logger = vi.hoisted(() => ({ warn: vi.fn(), info: vi.fn() }));
vi.mock("../logging/subsystem.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../logging/subsystem.js")>();
  return {
    ...actual,
    createSubsystemLogger: (name: string) => {
      const original = actual.createSubsystemLogger(name);
      return name === "state/agent-db" ? { ...original, ...logger } : original;
    },
  };
});

const tempDirs: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await closeOpenClawAgentDatabasesAsync();
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  cleanupTempDirs(tempDirs);
  logger.warn.mockClear();
  logger.info.mockClear();
});

function createTimedOpen(indexRepairMs = 0) {
  const options = {
    agentId: "timing-test",
    env: { OPENCLAW_STATE_DIR: makeTempDir(tempDirs, "openclaw-agent-open-timing-") },
  };
  const pathname = resolveOpenClawAgentSqlitePath(options);
  let elapsedMs = 0;
  const advance = (durationMs: number) => {
    elapsedMs += durationMs;
  };
  const wallStartedAt = Date.now();
  vi.spyOn(Date, "now").mockImplementation(() => wallStartedAt + Math.floor(elapsedMs));
  vi.spyOn(performance, "now").mockImplementation(() => elapsedMs);

  // Real operations advance a controlled clock at their existing owner boundaries.
  const open = sqlite.openNodeSqliteDatabase;
  vi.spyOn(sqlite, "openNodeSqliteDatabase").mockImplementation((...args) => {
    const database = open(...args);
    if (args[0] === pathname) {
      advance(50);
      const exec = database.exec.bind(database);
      vi.spyOn(database, "exec").mockImplementation((sql) => {
        exec(sql);
        if (sql.startsWith("CREATE INDEX main.idx_agent_session_nodes_updated_at ")) {
          advance(indexRepairMs);
        }
      });
    }
    return database;
  });
  const ensurePermissions = permissions.ensureOpenClawAgentDatabasePermissions;
  vi.spyOn(permissions, "ensureOpenClawAgentDatabasePermissions").mockImplementation((...args) => {
    ensurePermissions(...args);
    advance(10);
  });
  const configure = wal.configureSqliteConnectionPragmas;
  vi.spyOn(wal, "configureSqliteConnectionPragmas").mockImplementation((...args) => {
    const result = configure(...args);
    if (args[1]?.databasePath === pathname) {
      advance(80);
    }
    return result;
  });
  const ensureSchema = schema.ensureOpenClawAgentSchema;
  vi.spyOn(schema, "ensureOpenClawAgentSchema").mockImplementation((...args) => {
    ensureSchema(...args);
    advance(90);
  });
  const register = registry.registerOpenClawAgentDatabase;
  vi.spyOn(registry, "registerOpenClawAgentDatabase").mockImplementation((...args) => {
    const result = register(...args);
    advance(70);
    return result;
  });
  return { options, pathname, advance };
}

describe("agent database open timings", () => {
  it("reports canonical index repair separately from other open phases", () => {
    const { options, pathname } = createTimedOpen(1_000);
    const database = openOpenClawAgentDatabase(options);
    database.db.exec(`
    INSERT INTO session_nodes (session_key, current_session_id, entry_json, updated_at)
    VALUES ('session-one', 'window-one', '{}', 1);
    DROP INDEX idx_agent_session_nodes_updated_at;
    CREATE INDEX idx_agent_session_nodes_updated_at ON session_nodes(session_key);
  `);
    closeOpenClawAgentDatabaseByPath(pathname);
    logger.warn.mockClear();

    const reopened = openOpenClawAgentDatabase(options);
    expect(
      reopened.db
        .prepare(
          "SELECT session_key FROM session_nodes INDEXED BY idx_agent_session_nodes_updated_at",
        )
        .all(),
    ).toEqual([{ session_key: "session-one" }]);
    expect(reopened.db.prepare("PRAGMA integrity_check").get()).toEqual({
      integrity_check: "ok",
    });
    expect(logger.warn).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining(
        `Rebuilt canonical agent SQLite indexes for ${options.agentId} (${pathname}):`,
      ),
      {
        agentId: options.agentId,
        path: pathname,
        indexes: ["idx_agent_session_nodes_updated_at"],
        elapsedMs: 1_000,
      },
    );
    expect(logger.warn).toHaveBeenNthCalledWith(
      2,
      "slow OpenClaw agent database open",
      expect.objectContaining({
        elapsedMs: 1_150,
        integrityGateOutcome: "cached",
        canonicalIndexMs: 1_000,
        repairedIndexCount: 1,
        phaseDurationsMs: {
          open: 60,
          validation: 1_000,
          configuration: 80,
          schema: 0,
          registration: 10,
        },
      }),
    );
  });

  it("includes asynchronous admission waiting once for coalesced callers", async () => {
    const { options, pathname, advance } = createTimedOpen();
    openOpenClawAgentDatabase(options);
    closeOpenClawAgentDatabasesForTest();
    revokeSqliteDatabaseAdmissionsForPath(pathname);
    logger.warn.mockClear();
    const nativeFinished = createDeferredCore();
    const release = createDeferredCore();
    const check = integrityWorker.assertSqliteIntegrityInWorker;
    const worker = vi
      .spyOn(integrityWorker, "assertSqliteIntegrityInWorker")
      .mockImplementation(async (...args) => {
        try {
          await check(...args);
        } catch (error) {
          nativeFinished.reject(error);
          throw error;
        }
        nativeFinished.resolve();
        await release.promise;
      });
    const databases: Array<ReturnType<typeof openOpenClawAgentDatabase>> = [];
    const collect = (database: ReturnType<typeof openOpenClawAgentDatabase>) => {
      databases.push(database);
    };
    const outcomes = Promise.allSettled([
      withOpenClawAgentDatabaseAsync(options, collect),
      withOpenClawAgentDatabaseAsync(options, collect),
    ]);
    try {
      await nativeFinished.promise;
      advance(1_000);
      expect(databases).toHaveLength(0);
      expect(logger.warn).not.toHaveBeenCalled();
      release.resolve();
      expect(await outcomes).toEqual([
        { status: "fulfilled", value: undefined },
        { status: "fulfilled", value: undefined },
      ]);
      expect(worker).toHaveBeenCalledOnce();
      expect(databases).toHaveLength(2);
      expect(databases[1]).toBe(databases[0]);
      expect(databases[0]?.db.isOpen).toBe(true);
      expect(logger.warn).toHaveBeenCalledExactlyOnceWith(
        "slow OpenClaw agent database open",
        expect.objectContaining({
          agentId: options.agentId,
          elapsedMs: 1_310,
          path: pathname,
          pid: process.pid,
          threadId,
          isMainThread,
          admissionMode: "async",
          thresholdMs: 1_000,
          integrityGateMs: 1_000,
          integrityGateOutcome: "healthy",
          integrityGateReason: "no-proof",
          integrityGateMode: "full",
          integrityWorkerCheckMs: expect.any(Number),
          integrityWorkerLifetimeMs: 0,
          integrityOutsideWorkerMs: 1_000,
          canonicalIndexMs: 0,
          repairedIndexCount: 0,
          phaseDurationsMs: {
            open: 60,
            validation: 1_000,
            configuration: 80,
            schema: 90,
            registration: 80,
          },
        }),
      );
      expect(logger.warn.mock.calls[0]?.[1]).not.toHaveProperty("integrityCheckSyncMs");
      expect(logger.warn.mock.calls[0]?.[1]).not.toHaveProperty("integrityOutsideCheckMs");
    } finally {
      release.resolve();
      await outcomes;
    }
  });
});
