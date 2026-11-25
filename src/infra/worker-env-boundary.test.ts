import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { inspectDoctorDatabaseEngines } from "../commands/doctor-database-engine-inspection.js";
import { preparePostgresBackupDiscovery } from "./backup-database-discovery.js";
import { withDatabaseEngineSelection } from "./database-engine/context.js";
import { createSqliteFamilyEngines } from "./database-engine/selection-fixture.test-support.js";
import { prepareUsageCostWorker } from "./session-cost-usage-worker-runtime.js";
import { captureSqliteWorkerStateContext } from "./sqlite-worker-state-context.js";
import { readUpdatePostgresState } from "./update-candidate-state.postgres.js";

const boundary = vi.hoisted(() => ({
  run: vi.fn<(input: unknown) => Promise<unknown>>(),
}));

// mock-isolation: Exercise the production payload producers at the native clone boundary without workers.
vi.mock("./worker-task-pool.js", async () => {
  const { WorkerTaskError } = await import("@openclaw/worker-runtime");
  const { createOwnedWorkerTaskPoolMock } = await import("./worker-task-pool.mock.test-support.js");
  return {
    WorkerTaskPool: class {
      run = boundary.run;
      async close() {}
      async rotate() {}
    },
    WorkerTaskError,
    createOwnedWorkerTaskPool: () => createOwnedWorkerTaskPoolMock({}),
  };
});

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.clearAllMocks());

it("snapshots Proxy environments before backup, update, and Doctor worker dispatch", async () => {
  const stateDir = tempDirs.make("worker-env-boundary-");
  const env = new Proxy({ OPENCLAW_STATE_DIR: stateDir, SYNTHETIC_ENV: "fixture" }, {});
  expect(() => structuredClone(env)).toThrow(expect.objectContaining({ name: "DataCloneError" }));
  const payloads: unknown[] = [];
  boundary.run.mockImplementation(async (input) => {
    payloads.push(input);
    return structuredClone(input);
  });

  await preparePostgresBackupDiscovery({ stateDir, config: {}, env });
  await inspectDoctorDatabaseEngines({ stateDir, config: {}, env });
  await withDatabaseEngineSelection(
    {
      effectiveEngines: createSqliteFamilyEngines(),
    },
    () => readUpdatePostgresState({ stateDir, config: {}, env }, new Map()),
  );

  expect(payloads).toHaveLength(3);
  expect(payloads[0]).toMatchObject({ env: { ...env } });
  expect(payloads[1]).toMatchObject({ env: { ...env } });
  expect(payloads[2]).toMatchObject({ input: { env: { ...env } } });
});

it("keeps the prepared usage worker location cloneable with a Proxy environment", () => {
  const stateDir = tempDirs.make("usage-worker-env-boundary-");
  const env = new Proxy({ OPENCLAW_STATE_DIR: stateDir, SYNTHETIC_ENV: "fixture" }, {});
  const prepared = prepareUsageCostWorker({
    agentId: "main",
    agentDir: path.join(stateDir, "agent"),
    config: {},
    env,
  });
  expect(structuredClone(prepared.location).env).toEqual({ ...env });
  expect(prepared.location.env).not.toBe(env);
});

it("snapshots both SQLite worker state environments", () => {
  const stateDir = tempDirs.make("sqlite-worker-env-boundary-");
  const env = new Proxy({ OPENCLAW_STATE_DIR: stateDir, SYNTHETIC_ENV: "fixture" }, {});
  const captured = captureSqliteWorkerStateContext({
    environment: env,
    initializationEnvironment: env,
  });
  expect(structuredClone(captured)).toMatchObject({
    environment: { ...env },
    initializationEnvironment: { ...env },
  });
  expect(captured.environment).not.toBe(env);
  expect(captured.initializationEnvironment).not.toBe(env);
});
