import path from "node:path";

export function sqliteLifecycleFixtureFiles(repoRoot: string): Record<string, string> {
  const source = (name: string) => JSON.stringify(path.join(repoRoot, "src", name));
  const readPoolFixture = `
const readPool = vi.hoisted(() => ({ close: vi.fn(async () => {}) }));
vi.mock(${source("infra/runtime-process-url.ts")}, () => ({
  resolveRuntimeProcessEntrypointUrl: () => new URL("file:///synthetic/state-read.worker.js"),
}));
vi.mock(${source("infra/worker-task-pool.ts")}, () => ({
  WorkerTaskError: class extends Error {},
  createOwnedWorkerTaskPool: () => ({
    runTask: () => ({
      result: Promise.resolve({ ok: true, type: "fleet.list", sourceAdmitted: true, cells: [] }),
      close: async () => {},
    }),
    close: readPool.close,
    closeResources: async () => {},
  }),
}));
import { createOpenClawStateReadTransport } from ${source("state/openclaw-state-read-worker.ts")};
import { closeOpenClawStateDatabaseAsync } from ${source("state/openclaw-state-db-cache.ts")};
async function useReadPool() {
  const transport = createOpenClawStateReadTransport({ type: "fleet.list" });
  const authority = { signal: new AbortController().signal, assertCurrent() {} };
  try {
    expect(await transport.read({
      context: {
        environment: {},
        coordinatorRuntime: { directory: "/synthetic/coordinators", keepAlive: false },
        admission: {
          databasePath: "/synthetic/state.sqlite",
          identity: { key: "file:synthetic-state", canonicalPath: "/synthetic/state.sqlite" },
          assertCurrent() {},
        },
      },
      location: "/synthetic/state.sqlite",
      checkFreshAdmission: false,
    }, authority)).toMatchObject({ value: { ok: true, type: "fleet.list" } });
  } finally {
    await transport.close();
  }
}
`;
  // Run both clean task-store generations before the deliberate retained-custody failure.
  const taskStoreFixtures: Record<string, string> = {};
  for (const generation of ["first", "second"]) {
    taskStoreFixtures[`12-${generation === "first" ? "d" : "e"}-task-store.test.ts`] = `
import path from "node:path";
import { expect, it, vi } from "vitest";
import { createTaskFixture } from ${source("tasks/task-registry.test-support.ts")};
import { runOpenClawStateWriteTransaction } from ${source("state/openclaw-state-db.ts")};
import { listTaskRegistryRecordsByRuntimeSourceIdFromSqlite } from ${source("tasks/task-registry.store.sqlite.ts")};
it("persists task history through the ${generation} file's database owner", () => {
  vi.stubEnv("OPENCLAW_STATE_DIR", path.join(import.meta.dirname, "task-state-${generation}"));
  const sourceId = "cron-${generation}";
  const task = runOpenClawStateWriteTransaction(() => createTaskFixture("cron", {
    sourceId, runId: sourceId, task: "Keep task history in the current database generation",
    scopeKind: "system", ownerKey: "", status: "succeeded", notifyPolicy: "silent",
  }));
  expect(listTaskRegistryRecordsByRuntimeSourceIdFromSqlite({ runtime: "cron", sourceId }))
    .toEqual([expect.objectContaining({ taskId: task.taskId, status: "succeeded" })]);
});
`;
  }
  return {
    ...stateReadPoolFixtureFiles(repoRoot),
    ...taskStoreFixtures,
    ...failedDrainFixtureFiles(repoRoot, readPoolFixture),
    "11-a-sqlite-owner.test.ts": `
import { afterAll, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
vi.mock(${source("infra/runtime-worker-url.ts")}, () => ({
  resolveRuntimeWorkerUrl: () => new URL("file:///synthetic/shared-state.worker.js"),
}));
import { isSqliteWorkerStoreAvailable } from ${source("infra/sqlite-worker-store.ts")};
import { registerOpenClawStateDatabaseAsyncResource } from ${source("state/openclaw-state-db-cache.ts")};
import { openOpenClawStateWorkerCleanupStore } from ${source("state/openclaw-state-worker-store.ts")};
import { openOpenClawAgentDatabase } from ${source("state/openclaw-agent-db.ts")};
import { tryAcquireExclusiveSqliteCoordinator } from ${source("infra/sqlite-coordinator.ts")};
import { captureCoordinatorDatabase } from ${source("infra/sqlite-coordinator.test-support.ts")};
${readPoolFixture}
const drainKey = Symbol.for("fixture.sqliteDrain");
it("retains a real shared-state owner after host admission is refused", async () => {
  await useReadPool();
  expect(isSqliteWorkerStoreAvailable({})).toBe(false);
  await expect(openOpenClawStateWorkerCleanupStore("/synthetic/state.sqlite", {
    environment: { OPENCLAW_STATE_DIR: "/synthetic" },
    coordinatorRuntime: { directory: "/synthetic/coordinators", keepAlive: false },
  }, () => {})).rejects.toMatchObject({ code: "unavailable" });
  const database = openOpenClawAgentDatabase({
    agentId: "fixture",
    env: { OPENCLAW_STATE_DIR: path.join(import.meta.dirname, "agent-state") },
  });
  const coordinatorPath = path.join(import.meta.dirname, "late-idle-coordinator.sqlite");
  fs.writeFileSync(coordinatorPath, "");
  const coordinator = captureCoordinatorDatabase(() =>
    tryAcquireExclusiveSqliteCoordinator(coordinatorPath, { keepAlive: true }),
  );
  const retained = { database, coordinator, drains: 0 };
  Reflect.set(globalThis, drainKey, retained);
  registerOpenClawStateDatabaseAsyncResource({ async close() {
    expect(Reflect.get(globalThis, drainKey)).toBe(retained);
    expect(database.db.isOpen).toBe(false);
    expect(retained.drains).toBe(0);
    await Promise.resolve();
    coordinator.result.release();
    retained.drains++;
  } });
});
afterAll(() => {
  const retained = Reflect.get(globalThis, drainKey);
  expect(retained.database.db.isOpen).toBe(true);
  expect(retained.coordinator.database.isTransaction).toBe(true);
  expect(retained.drains).toBe(0);
  vi.resetModules();
});
`,
    "11-b-sqlite-cleanup.test.ts": `
import { afterEach, expect, it, vi } from "vitest";
import type { SqliteWorkerStore } from ${source("infra/sqlite-worker-contract.ts")};
import {
  runWithSqliteWorkerStateContext,
  type SqliteWorkerStateContext,
} from ${source("infra/sqlite-worker-state-context.ts")};
import { cleanupRetiredAgentDatabaseLease } from ${source("state/openclaw-agent-execution-cleanup.ts")};
import {
  assertOpenClawStateSchemaRepairAllowed,
  getExistingOpenClawStateSchemaPath,
} from ${source("state/openclaw-state-db-schema-policy.ts")};
import type { OpenClawStateWorkerContext } from ${source("state/openclaw-state-worker-context.types.ts")};
import type { OpenClawStateWorkerCleanupOperations } from ${source("state/openclaw-state-worker-contract.ts")};
${readPoolFixture}

// Keep the real shared-state owner in this cross-file proof; another test's mocks
// are not part of the runner's lifecycle contract.
const drainKey = Symbol.for("fixture.sqliteDrain");
const retained = Reflect.get(globalThis, drainKey);
expect(retained.drains).toBe(1);
expect(retained.database.db.isOpen).toBe(false);
expect(retained.coordinator.database.isOpen).toBe(false);
Reflect.deleteProperty(globalThis, drainKey);

const edge = vi.hoisted(() => ({
  close: vi.fn(async () => {}),
  repairs: [] as Array<{ phase: string; error: unknown }>,
  forbidden: vi.fn((): never => {
    throw new Error("Cleanup schema proof crossed a native database or Worker boundary");
  }),
}));

vi.mock("node:sqlite", () => ({ DatabaseSync: edge.forbidden }));
vi.mock("node:worker_threads", () => ({ Worker: edge.forbidden }));
vi.mock(${source("infra/runtime-worker-url.ts")}, () => ({
  resolveRuntimeWorkerUrl: () => new URL("file:///synthetic/shared-state.worker.js"),
}));
vi.mock(${source("infra/sqlite-worker-identity.ts")}, () => ({
  readDatabasePathIdentity: async (canonicalPath: string) => ({
    key: "file:synthetic-state",
    canonicalPath,
  }),
}));
vi.mock(${source("infra/sqlite-worker-store.ts")}, () => ({
  openSharedStateSqliteWorkerStore: async (
    options: { databasePath: string },
    context: SqliteWorkerStateContext,
  ) => {
    runWithSqliteWorkerStateContext(context, () =>
      inspectRepairPolicy("open", options.databasePath),
    );
    const store: SqliteWorkerStore<OpenClawStateWorkerCleanupOperations> = {
      async execute(command) {
        inspectRepairPolicy("cleanup", command.input.sharedStatePath);
      },
      close: edge.close,
    };
    return store;
  },
  runSqliteWorkerStoreOperation: async (
    store: SqliteWorkerStore<OpenClawStateWorkerCleanupOperations>,
    operation: (scope: SqliteWorkerStore<OpenClawStateWorkerCleanupOperations>) => Promise<void>,
    context: SqliteWorkerStateContext,
  ) => runWithSqliteWorkerStateContext(context, () => operation(store)),
}));

function inspectRepairPolicy(phase: string, databasePath: string) {
  let error: unknown;
  try {
    assertOpenClawStateSchemaRepairAllowed(databasePath);
  } catch (failure) {
    error = failure;
  }
  edge.repairs.push({ phase, error });
}

afterEach(() => {
  expect(edge.forbidden).not.toHaveBeenCalled();
  edge.repairs.length = 0;
  vi.clearAllMocks();
});

it("retains installed-schema repair ownership through retired agent lease cleanup", async () => {
  const databasePath = "/synthetic/state/openclaw.sqlite";
  const context: OpenClawStateWorkerContext = {
    environment: { OPENCLAW_STATE_DIR: "/synthetic" },
    coordinatorRuntime: { directory: "/synthetic/coordinators", keepAlive: true },
    existingSchemaPath: databasePath,
    admission: {
      databasePath,
      identity: { key: "file:synthetic-state", canonicalPath: databasePath },
      assertCurrent() {},
    },
  };
  // There is no ambient schema scope for the mocked transport to inherit.
  expect(getExistingOpenClawStateSchemaPath()).toBeUndefined();
  await cleanupRetiredAgentDatabaseLease({
    context,
    stopped: Promise.resolve(),
    assertOwned() {},
    lease: {
      leaseId: "synthetic-lease",
      agentId: "main",
      path: "/synthetic/agents/main.sqlite",
      ownerPid: process.pid,
      ownerStartTime: null,
      sharedStatePath: databasePath,
      sharedStateIdentity: "file:synthetic-state",
    },
  });
  expect(edge.repairs).toEqual(
    ["open", "cleanup"].map((phase) => ({
      phase,
      error: expect.objectContaining({
        message: expect.stringContaining("schema repair is owned by the existing installation"),
      }),
    })),
  );
  expect(edge.close).toHaveBeenCalledOnce();
  expect(getExistingOpenClawStateSchemaPath()).toBeUndefined();
  await useReadPool();
  await closeOpenClawStateDatabaseAsync();
  expect(readPool.close).toHaveBeenCalledOnce();
});
`,
  };
}

function failedDrainFixtureFiles(
  repoRoot: string,
  readPoolFixture: string,
): Record<string, string> {
  const source = (name: string) => JSON.stringify(path.join(repoRoot, "src", name));
  return {
    "13-a-retained-lease.test.ts": `
import fs from "node:fs";
import path from "node:path";
import { afterAll, expect, it, vi } from "vitest";
vi.mock(${source("infra/runtime-worker-url.ts")}, () => ({
  resolveRuntimeWorkerUrl: () => new URL("file:///synthetic/shared-state.worker.js"),
}));
import { resolveGlobalSingleton } from ${source("shared/global-singleton.ts")};
import { openOpenClawAgentDatabase } from ${source("state/openclaw-agent-db.ts")};
import { agentDatabaseLifecycle, closeOpenClawAgentDatabasesAsync } from ${source("state/openclaw-agent-db-lifecycle.ts")};
import { registerOpenClawAgentDatabaseAsyncResource } from ${source("state/openclaw-agent-db-resources.ts")};
import { openOpenClawStateWorkerCleanupStore } from ${source("state/openclaw-state-worker-store.ts")};
import { isSqliteWorkerStoreAvailable } from ${source("infra/sqlite-worker-store.ts")};
import { closeIdleSqliteCoordinators, tryAcquireExclusiveSqliteCoordinator } from ${source("infra/sqlite-coordinator.ts")};
import { captureCoordinatorDatabase } from ${source("infra/sqlite-coordinator.test-support.ts")};
${readPoolFixture}
const probeKey = Symbol.for("fixture.retainedAgentLease");
it("retains its native handle and lease when resource teardown refuses cleanup", async () => {
  await useReadPool();
  expect(isSqliteWorkerStoreAvailable({})).toBe(false);
  await expect(openOpenClawStateWorkerCleanupStore("/synthetic/state.sqlite", {
    environment: { OPENCLAW_STATE_DIR: "/synthetic" },
    coordinatorRuntime: { directory: "/synthetic/coordinators", keepAlive: false },
  }, () => {})).rejects.toMatchObject({ code: "unavailable" });
  const root = path.join(import.meta.dirname, "retained-agent-state");
  const database = openOpenClawAgentDatabase({ agentId: "retained", env: { OPENCLAW_STATE_DIR: root } });
  const lease = agentDatabaseLifecycle.leases.get(database.path);
  if (!lease) throw new Error("Fixture database did not acquire its native lease");
  const coordinatorPath = path.join(import.meta.dirname, "retained-idle-coordinator.sqlite");
  fs.writeFileSync(coordinatorPath, "");
  const coordinator = captureCoordinatorDatabase(() =>
    tryAcquireExclusiveSqliteCoordinator(coordinatorPath, { keepAlive: true }),
  );
  coordinator.result.release();
  const keys = ["sharedStateWorkerOwner", "sqliteWorkerBroker", "sqliteCoordinatorPool", "stateDatabaseLifecycle", "stateReadWorkers", "agentDatabaseLifecycle"].map((name) => Symbol.for("openclaw." + name));
  const resets = Reflect.get(globalThis, Symbol.for("openclaw.globalSingletonLifecycleResets"));
  const probe = {
    database, lease, root, coordinator, closeCoordinators: () => closeIdleSqliteCoordinators(import.meta.dirname), attempts: 0, allowClose: false, independentCloses: 0, failedIndependentCloses: 0, afterAll: false,
    owners: keys.map((key) => [key, Reflect.get(globalThis, key)]),
    resets: keys.filter((key) => resets.has(key)).map((key) => [key, resets.get(key)]),
    close: closeOpenClawAgentDatabasesAsync,
    register: registerOpenClawAgentDatabaseAsyncResource,
  };
  expect(probe.owners.every(([, owner]) => owner !== undefined)).toBe(true);
  expect(probe.resets.length).toBeGreaterThan(0);
  Reflect.set(globalThis, probeKey, probe);
  resolveGlobalSingleton(Symbol.for("fixture.independentDrain"), () => ({}), () => {
    probe.independentCloses++;
    console.log("retained-lease-independent-reset: " + probe.independentCloses);
  });
  const failedIndependentKey = Symbol.for("fixture.failedIndependentDrain");
  resolveGlobalSingleton(failedIndependentKey, () => ({}), () => {
    probe.failedIndependentCloses++;
    console.log("retained-lease-failed-reset: " + probe.failedIndependentCloses);
    throw new Error("Synthetic independent singleton cleanup refused");
  });
  probe.resets.push([failedIndependentKey, resets.get(failedIndependentKey)]);
  registerOpenClawAgentDatabaseAsyncResource({
    agentId: database.agentId,
    path: database.path,
    revoke() {},
    async close() {
      probe.attempts++;
      if (!probe.allowClose) {
        throw new Error("Synthetic retired lease cleanup refused: leaseId=" + lease.leaseId + " path=" + database.path);
      }
    },
  });
  console.log("retained-lease-identity: " + JSON.stringify({ leaseId: lease.leaseId, path: database.path }));
});
afterAll(() => {
  const probe = Reflect.get(globalThis, probeKey);
  expect(probe.database.db.isOpen).toBe(true);
  expect(probe.coordinator.database.isOpen).toBe(true);
  expect(probe.attempts).toBe(0);
  probe.afterAll = true;
});
`,
    "13-b-retained-lease-observer.test.ts": `
import { expect, it, vi } from "vitest";
vi.mock(${source("infra/runtime-process-url.ts")}, () => ({
  resolveRuntimeProcessEntrypointUrl: () => new URL("file:///synthetic/observer-process.js"),
}));
import { resolveRuntimeProcessEntrypointUrl } from ${source("infra/runtime-process-url.ts")};
it("preserves failed custody while independent cleanup and the next file still run", async () => {
  const probeKey = Symbol.for("fixture.retainedAgentLease");
  const probe = Reflect.get(globalThis, probeKey);
  const resets = Reflect.get(globalThis, Symbol.for("openclaw.globalSingletonLifecycleResets"));
  try {
    expect(probe.afterAll).toBe(true);
    expect(probe.attempts, "file teardown must not retry the failed closer").toBe(1);
    expect(probe.database.db.isOpen).toBe(true);
    expect(probe.coordinator.database.isOpen).toBe(true);
    for (const [key, owner] of probe.owners) expect(Reflect.get(globalThis, key)).toBe(owner);
    for (const [key, reset] of probe.resets) expect(resets.get(key)).toBe(reset);
    const owner = Reflect.get(globalThis, Symbol.for("openclaw.agentDatabaseLifecycle"));
    expect(owner.leases.get(probe.database.path)).toBe(probe.lease);
    expect(probe.independentCloses).toBe(1);
    expect(probe.failedIndependentCloses).toBe(1);
    expect(resolveRuntimeProcessEntrypointUrl("sharedStateStore").href).toBe("file:///synthetic/observer-process.js");
    expect(() => probe.register({ agentId: "retained", path: probe.database.path, revoke() {}, async close() {} })).toThrow("resources are closing");
  } finally {
    // Explicitly discharge the fixture's fault after observing retained custody.
    probe.allowClose = true;
    await probe.close(probe.root);
    probe.closeCoordinators();
    Reflect.deleteProperty(globalThis, probeKey);
    // Keep both singleton callbacks registered through observer teardown: the
    // successful callback must run again, while the failed callback must not.
  }
  expect(probe.attempts).toBe(2);
  expect(probe.database.db.isOpen).toBe(false);
  expect(probe.coordinator.database.isOpen).toBe(false);
  const owner = Reflect.get(globalThis, Symbol.for("openclaw.agentDatabaseLifecycle"));
  expect(owner.leases.has(probe.database.path)).toBe(false);
});
`,
  };
}

function stateReadPoolFixtureFiles(repoRoot: string): Record<string, string> {
  const source = (name: string) => JSON.stringify(path.join(repoRoot, "src", name));
  return Object.fromEntries(
    ["a", "b", "c"].map((generation) => [
      `12-${generation}-state-read-pool.test.ts`,
      `
import fs from "node:fs";
import path from "node:path";
import { afterAll, expect, it, vi } from "vitest";
import { executeExistingOpenClawStateRead } from ${source("state/openclaw-state-db-readonly.ts")};
import { readWorkspaceStateSnapshot } from ${source("agents/workspace-state-store.ts")};
import { createWorkspaceStateIdentity } from ${source("agents/workspace-state-identity.ts")};

const generation = ${JSON.stringify(generation)};
const probeKey = Symbol.for("fixture.stateReadPoolGenerations");
const probe = Reflect.get(globalThis, probeKey) ?? { closes: [] as string[], reads: [] as string[] };
Reflect.set(globalThis, probeKey, probe);
const edge = vi.hoisted(() => ({ create: vi.fn(), close: vi.fn(async () => {}) }));
vi.mock(${source("infra/worker-task-pool.ts")}, async (importOriginal) => ({
  ...await importOriginal<typeof import(${source("infra/worker-task-pool.ts")})>(),
  createOwnedWorkerTaskPool: edge.create,
}));
edge.close.mockImplementation(async () => { probe.closes.push(generation); });
edge.create.mockImplementation(() => ({
  runTask: () => {
    probe.reads.push(generation);
    return {
      result: Promise.resolve(generation === "c" ? {
        ok: true, type: "workspace.snapshot", sourceAdmitted: true,
        snapshot: { identity: createWorkspaceStateIdentity("/fixture/workspace"), setupExists: false, setup: { version: 1 } },
      } : { ok: true, type: "fleet.list", sourceAdmitted: true, cells: [] }),
      close: async () => {},
    };
  },
  close: edge.close,
  closeResources: async () => {},
}));

it("rebinds the shared read pool to generation " + generation, async () => {
  const pathname = path.join(import.meta.dirname, "read-" + generation + ".sqlite");
  // The transport is controlled; the real read owner uses only file identity.
  fs.writeFileSync(pathname, "synthetic reader source");
  const options = { path: pathname, env: { OPENCLAW_STATE_DIR: import.meta.dirname } };
  if (generation === "c") {
    const result = await readWorkspaceStateSnapshot("/fixture/workspace", { ...options, readOnly: true });
    expect(result.setupExists).toBe(false);
    expect(probe.reads).toEqual(["a", "b", "c"]);
    expect(probe.closes).toEqual(["a", "b"]);
  } else {
    await expect(executeExistingOpenClawStateRead(options, { type: "fleet.list" })).resolves.toMatchObject({ type: "fleet.list" });
  }
  expect(edge.create).toHaveBeenCalledOnce();
  expect(edge.close).not.toHaveBeenCalled();
});
afterAll(() => {
  expect(edge.close).not.toHaveBeenCalled();
  if (generation === "c") Reflect.deleteProperty(globalThis, probeKey);
});
`,
    ]),
  );
}
