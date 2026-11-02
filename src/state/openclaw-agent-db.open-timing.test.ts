import { performance } from "node:perf_hooks";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as sqlite from "../infra/node-sqlite.js";
import * as integrityWorker from "../infra/sqlite-integrity-worker.js";
import { createDeferredCore } from "../shared/deferred.js";
import { invalidateOpenClawAgentDatabaseIntegrityBeforeMutation } from "./openclaw-agent-db-lease.js";
import { useAgentDatabaseDirectories } from "./openclaw-agent-db-lifecycle.test-support.js";
import {
  closeOpenClawAgentDatabaseByPath as closeAgentDb,
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase as openAgentDb,
  withOpenClawAgentDatabaseAsync as withAgentDb,
  resolveOpenClawAgentSqlitePath as agentDbPath,
} from "./openclaw-agent-db.js";

const logger = vi.hoisted(() => ({ warn: vi.fn() }));
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

const tempDirs = useAgentDatabaseDirectories(() => {
  vi.restoreAllMocks();
});
afterEach(() => logger.warn.mockClear());

function createTimedOpen(indexRepairMs = 0) {
  const options = {
    agentId: "timing-test",
    env: { OPENCLAW_STATE_DIR: tempDirs.make("openclaw-agent-open-timing-") },
  };
  const pathname = agentDbPath(options);
  let elapsedMs = 0;
  const advance = (durationMs: number) => {
    elapsedMs += durationMs;
  };
  vi.spyOn(performance, "now").mockImplementation(() => elapsedMs);

  // Real operations advance a controlled clock at their existing owner boundaries.
  const open = sqlite.openNodeSqliteDatabase;
  vi.spyOn(sqlite, "openNodeSqliteDatabase").mockImplementation((...args) => {
    const database = open(...args);
    if (args[0] === pathname) {
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
  return { options, pathname, advance };
}

describe("agent database open timings", () => {
  it("reports canonical index repair separately from other open phases", () => {
    const { options, pathname } = createTimedOpen(1_000);
    openAgentDb(options).db.exec(`
    DROP INDEX idx_agent_session_nodes_updated_at;
    CREATE INDEX idx_agent_session_nodes_updated_at ON session_nodes(session_key);
  `);
    closeAgentDb(pathname);
    logger.warn.mockClear();

    openAgentDb(options);
    expect(logger.warn.mock.calls.map(([, fields]) => fields)).toMatchObject([
      {
        indexes: ["idx_agent_session_nodes_updated_at"],
        elapsedMs: 1_000,
      },
      {
        elapsedMs: 1_000,
        integrityGateOutcome: "cached",
        canonicalIndexMs: 1_000,
        repairedIndexCount: 1,
        phaseDurationsMs: {
          validation: 1_000,
        },
      },
    ]);
  });

  it("includes asynchronous admission waiting once for coalesced callers", async () => {
    const { options, pathname, advance } = createTimedOpen();
    openAgentDb(options);
    closeOpenClawAgentDatabasesForTest();
    invalidateOpenClawAgentDatabaseIntegrityBeforeMutation(pathname);
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
    const databases: Array<ReturnType<typeof openAgentDb>> = [];
    const collect = (database: ReturnType<typeof openAgentDb>) => {
      databases.push(database);
    };
    const outcomes = Promise.allSettled([
      withAgentDb(options, collect),
      withAgentDb(options, collect),
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
          elapsedMs: 1_000,
          admissionMode: "async",
          thresholdMs: 1_000,
          integrityGateMs: 1_000,
          integrityGateOutcome: "healthy",
          integrityWorkerLifetimeMs: 0,
          integrityOutsideWorkerMs: 1_000,
          phaseDurationsMs: expect.objectContaining({
            validation: 1_000,
          }),
        }),
      );
    } finally {
      release.resolve();
      await outcomes;
    }
  });
});
