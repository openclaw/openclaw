const unavailableSharedStateWorkerFixture = `
vi.mock(${JSON.stringify(import.meta.resolve("../src/infra/runtime-worker-url.ts"))}, async (importOriginal) => {
  const actual = await importOriginal<typeof import(${JSON.stringify(import.meta.resolve("../src/infra/runtime-worker-url.ts"))})>();
  return {
    ...actual,
    resolveRuntimeWorkerUrl: (params: Parameters<typeof actual.resolveRuntimeWorkerUrl>[0]) =>
      params.distWorkerPath === "state/openclaw-state.worker.js"
        ? new URL("file:///synthetic/shared-state.worker.js")
        : actual.resolveRuntimeWorkerUrl(params),
  };
});
`;

// Literal resolver calls keep generated imports visible to CI's dependency graph.
export function sqliteLifecycleFixtureFiles(): Record<string, string> {
  const readPoolFixture = `
import { startAwaitedReadMock } from ${JSON.stringify(import.meta.resolve("../src/state/openclaw-state-read-mock.test-support.ts"))};
const readPool = vi.hoisted(() => ({ close: vi.fn(async () => {}) }));
vi.mock(${JSON.stringify(import.meta.resolve("../src/infra/runtime-process-url.ts"))}, () => ({
  resolveRuntimeProcessEntrypointUrl: () => new URL("file:///synthetic/state-read.worker.js"),
}));
vi.mock(${JSON.stringify(import.meta.resolve("../src/infra/worker-task-pool.ts"))}, () => ({
  WorkerTaskError: class extends Error {},
  createOwnedWorkerTaskPool: () => ({
    startTask: () => ({
      ...startAwaitedReadMock(async () => ({ ok: true, type: "fleet.list", sourceAdmitted: true, cells: [] })),
      release: () => startAwaitedReadMock(async () => {}),
    }),
    close: readPool.close,
    closeResources: async () => {},
  }),
}));
import { captureOpenClawStateReadSource } from ${JSON.stringify(import.meta.resolve("../src/state/openclaw-state-read-worker.ts"))};
import { closeOpenClawStateDatabaseAsync } from ${JSON.stringify(import.meta.resolve("../src/state/openclaw-state-db-cache.ts"))};
async function useReadPool() {
  const transport = captureOpenClawStateReadSource().createTransport({ type: "fleet.list" });
  const authority = { signal: new AbortController().signal, assertCurrent() {} };
  try {
    expect(await transport.startRead({
      context: {
        environment: {},
        admission: {
          databasePath: "/synthetic/state.sqlite",
          identity: { key: "file:synthetic-state", canonicalPath: "/synthetic/state.sqlite" },
          assertCurrent() {},
        },
      },
      location: "/synthetic/state.sqlite",
      checkFreshAdmission: false,
    }, authority).result).toMatchObject({ value: { ok: true, type: "fleet.list" } });
  } finally {
    await transport.startClose().result;
  }
}
`;
  return {
    ...sharedStateOwnerFixtureFiles(),
    ...scheduledCloseFixtureFiles(),
    ...subagentRetirementFixtureFiles(),
    ...stateReadPoolFixtureFiles(),
    ...failedDrainFixtureFiles(readPoolFixture),
    "11-a-sqlite-owner.test.ts": `
import { afterAll, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
${unavailableSharedStateWorkerFixture}
import { isSqliteWorkerStoreAvailable } from ${JSON.stringify(import.meta.resolve("../src/infra/sqlite-worker-store.ts"))};
import { readDatabasePathIdentitySync } from ${JSON.stringify(import.meta.resolve("../src/infra/sqlite-worker-identity.ts"))};
import { registerOpenClawStateDatabaseAsyncResource } from ${JSON.stringify(import.meta.resolve("../src/state/openclaw-state-db-cache.ts"))};
import { openOpenClawStateWorkerCleanupStore } from ${JSON.stringify(import.meta.resolve("../src/state/openclaw-state-worker-store.ts"))};
import { openOpenClawAgentDatabase } from ${JSON.stringify(import.meta.resolve("../src/state/openclaw-agent-db.ts"))};
${readPoolFixture}
const drainKey = Symbol.for("fixture.sqliteDrain");
it("retains a real shared-state owner after host admission is refused", async () => {
  await useReadPool();
  expect(isSqliteWorkerStoreAvailable({})).toBe(false);
  const sharedPath = path.join(import.meta.dirname, "refused-owner.sqlite");
  fs.writeFileSync(sharedPath, "synthetic admission source");
  await expect(openOpenClawStateWorkerCleanupStore(sharedPath, {
    environment: { OPENCLAW_STATE_DIR: import.meta.dirname },
  }, () => {}, readDatabasePathIdentitySync(sharedPath))).rejects.toMatchObject({ code: "unavailable" });
  const database = openOpenClawAgentDatabase({
    agentId: "fixture",
    env: { OPENCLAW_STATE_DIR: path.join(import.meta.dirname, "agent-state") },
  });
  const retained = { database, drains: 0 };
  Reflect.set(globalThis, drainKey, retained);
  registerOpenClawStateDatabaseAsyncResource({ async close() {
    expect(Reflect.get(globalThis, drainKey)).toBe(retained);
    expect(database.db.isOpen).toBe(false);
    expect(retained.drains).toBe(0);
    await Promise.resolve();
    retained.drains++;
  } });
});
afterAll(() => {
  const retained = Reflect.get(globalThis, drainKey);
  expect(retained.database.db.isOpen).toBe(true);
  expect(retained.drains).toBe(0);
  vi.resetModules();
});
`,
    "11-b-sqlite-cleanup.test.ts": `
import { afterEach, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { readDatabasePathIdentitySync } from ${JSON.stringify(import.meta.resolve("../src/infra/sqlite-worker-identity.ts"))};
import type { SqliteWorkerStore } from ${JSON.stringify(import.meta.resolve("../src/infra/sqlite-worker-contract.ts"))};
import {
  runWithSqliteWorkerStateContext,
  type SqliteWorkerStateContext,
} from ${JSON.stringify(import.meta.resolve("../src/infra/sqlite-worker-state-context.ts"))};
import { cleanupRetiredAgentDatabaseLease } from ${JSON.stringify(import.meta.resolve("../src/state/openclaw-agent-execution-cleanup.ts"))};
import {
  assertOpenClawStateSchemaRepairAllowed,
  getExistingOpenClawStateSchemaPath,
} from ${JSON.stringify(import.meta.resolve("../src/state/openclaw-state-db-schema-policy.ts"))};
import type { OpenClawStateWorkerContext } from ${JSON.stringify(import.meta.resolve("../src/state/openclaw-state-worker-context.types.ts"))};
import type { OpenClawStateWorkerCleanupOperations } from ${JSON.stringify(import.meta.resolve("../src/state/openclaw-state-worker-contract.ts"))};
${readPoolFixture}

// Keep the real shared-state owner in this cross-file proof; another test's mocks
// are not part of the runner's lifecycle contract.
const drainKey = Symbol.for("fixture.sqliteDrain");
const retained = Reflect.get(globalThis, drainKey);
expect(retained.drains).toBe(1);
expect(retained.database.db.isOpen).toBe(false);
Reflect.deleteProperty(globalThis, drainKey);

const edge = vi.hoisted(() => ({
  close: vi.fn(async () => {}),
  repairs: [] as Array<{ phase: string; error: unknown }>,
  forbidden: vi.fn((): never => {
    throw new Error("Cleanup schema proof crossed a native database or Worker boundary");
  }),
}));

vi.mock("node:sqlite", () => ({ DatabaseSync: edge.forbidden }));
vi.mock("node:worker_threads", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:worker_threads")>(),
  Worker: edge.forbidden,
}));
${unavailableSharedStateWorkerFixture}
vi.mock(${JSON.stringify(import.meta.resolve("../src/infra/sqlite-worker-store.ts"))}, () => ({
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
  const databasePath = path.join(import.meta.dirname, "cleanup-state.sqlite");
  fs.writeFileSync(databasePath, "synthetic cleanup source");
  const identity = readDatabasePathIdentitySync(databasePath);
  const context: OpenClawStateWorkerContext = {
    environment: { OPENCLAW_STATE_DIR: "/synthetic" },
    existingSchemaPath: databasePath,
    admission: {
      databasePath,
      identity,
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
      sharedStateIdentity: identity.key,
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

function scheduledCloseFixtureFiles(): Record<string, string> {
  return {
    "10-a-scheduled-close.test.ts": `
import { afterEach, expect, it } from "vitest";
import { closeOpenClawAgentDatabasesForTest } from ${JSON.stringify(import.meta.resolve("../src/state/openclaw-agent-db.ts"))};
import { hasOpenClawAgentDatabaseAsyncResources, registerOpenClawAgentDatabaseAsyncResource } from ${JSON.stringify(import.meta.resolve("../src/state/openclaw-agent-db-resources.ts"))};
const events: string[] = [];
// The synchronous test closer only schedules asynchronous Worker retirement.
afterEach(() => closeOpenClawAgentDatabasesForTest());
function registerClose(agentId: string) {
  registerOpenClawAgentDatabaseAsyncResource({
    agentId,
    path: "/synthetic/" + agentId + ".sqlite",
    revoke() {},
    // Worker retirement crosses threads, so it settles on a later event-loop turn. The
    // path from one test's teardown to the next test's start is promise-only, so without
    // the runner's join this close is still pending when the next test begins.
    close: () => new Promise<void>((resolve) => setImmediate(() => {
      events.push(agentId + " close settled");
      resolve();
    })),
  });
}
it("schedules a Worker close that its teardown does not await", () => {
  registerClose("scheduled");
});
it("starts only after that close settled", () => {
  events.push("next test started");
  expect(events).toEqual(["scheduled close settled", "next test started"]);
  expect(hasOpenClawAgentDatabaseAsyncResources()).toBe(false);
});
it("schedules a Worker close and then skips itself", (context) => {
  registerClose("skipped");
  context.skip();
});
it("starts only after the skipped test's close settled", () => {
  events.push("test after skip started");
  expect(events.slice(2)).toEqual(["skipped close settled", "test after skip started"]);
  expect(hasOpenClawAgentDatabaseAsyncResources()).toBe(false);
});
`,
    "10-b-around-each-close.test.ts": `
import { aroundEach, expect, it } from "vitest";
import { closeOpenClawAgentDatabasesForTest } from ${JSON.stringify(import.meta.resolve("../src/state/openclaw-agent-db.ts"))};
import { hasOpenClawAgentDatabaseAsyncResources, registerOpenClawAgentDatabaseAsyncResource } from ${JSON.stringify(import.meta.resolve("../src/state/openclaw-agent-db-resources.ts"))};
const events: string[] = [];
// aroundEach setup and teardown both run outside the runner's per-attempt hook.
aroundEach(async (runTest) => {
  events.push(hasOpenClawAgentDatabaseAsyncResources() ? "setup saw a pending close" : "setup");
  await runTest();
  closeOpenClawAgentDatabasesForTest();
});
it("schedules a Worker close from aroundEach teardown", () => {
  registerOpenClawAgentDatabaseAsyncResource({
    agentId: "around",
    path: "/synthetic/around.sqlite",
    revoke() {},
    // Settles on a later event-loop turn, like the scheduled close in 10-a.
    close: () => new Promise<void>((resolve) => setImmediate(() => {
      events.push("around close settled");
      resolve();
    })),
  });
});
it("starts only after the aroundEach close settled", () => {
  events.push("next test started");
  expect(events).toEqual(["setup", "around close settled", "setup", "next test started"]);
  expect(hasOpenClawAgentDatabaseAsyncResources()).toBe(false);
});
`,
  };
}

function failedDrainFixtureFiles(readPoolFixture: string): Record<string, string> {
  return {
    "13-a-retained-lease.test.ts": `
import fs from "node:fs";
import path from "node:path";
import { afterAll, expect, it, vi } from "vitest";
${unavailableSharedStateWorkerFixture}
import { resolveGlobalSingleton } from ${JSON.stringify(import.meta.resolve("../src/shared/global-singleton.ts"))};
import { openOpenClawAgentDatabase } from ${JSON.stringify(import.meta.resolve("../src/state/openclaw-agent-db.ts"))};
import { agentDatabaseLifecycle, closeOpenClawAgentDatabasesAsync } from ${JSON.stringify(import.meta.resolve("../src/state/openclaw-agent-db-lifecycle.ts"))};
import { registerOpenClawAgentDatabaseAsyncResource } from ${JSON.stringify(import.meta.resolve("../src/state/openclaw-agent-db-resources.ts"))};
import { openOpenClawStateWorkerCleanupStore } from ${JSON.stringify(import.meta.resolve("../src/state/openclaw-state-worker-store.ts"))};
import { isSqliteWorkerStoreAvailable } from ${JSON.stringify(import.meta.resolve("../src/infra/sqlite-worker-store.ts"))};
import { readDatabasePathIdentitySync } from ${JSON.stringify(import.meta.resolve("../src/infra/sqlite-worker-identity.ts"))};
${readPoolFixture}
const probeKey = Symbol.for("fixture.retainedAgentLease");
it("retains its native handle and lease when resource teardown refuses cleanup", async () => {
  await useReadPool();
  expect(isSqliteWorkerStoreAvailable({})).toBe(false);
  const sharedPath = path.join(import.meta.dirname, "refused-retained-owner.sqlite");
  fs.writeFileSync(sharedPath, "synthetic admission source");
  await expect(openOpenClawStateWorkerCleanupStore(sharedPath, {
    environment: { OPENCLAW_STATE_DIR: import.meta.dirname },
  }, () => {}, readDatabasePathIdentitySync(sharedPath))).rejects.toMatchObject({ code: "unavailable" });
  const root = path.join(import.meta.dirname, "retained-agent-state");
  const database = openOpenClawAgentDatabase({ agentId: "retained", env: { OPENCLAW_STATE_DIR: root } });
  const lease = agentDatabaseLifecycle.leases.get(database.path);
  if (!lease) throw new Error("Fixture database did not acquire its native lease");
  const keys = ["sharedStateWorkerOwner", "sqliteWorkerBroker", "stateDatabaseLifecycle", "stateReadWorkers", "agentDatabaseLifecycle"].map((name) => Symbol.for("openclaw." + name));
  const resets = Reflect.get(globalThis, Symbol.for("openclaw.globalSingletonLifecycleResets"));
  const probe = {
    database, lease, root, attempts: 0, allowClose: false, independentCloses: 0, failedIndependentCloses: 0, afterAll: false,
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
  expect(probe.attempts).toBe(0);
  probe.afterAll = true;
});
`,
    "13-b-retained-lease-observer.test.ts": `
import { expect, it, vi } from "vitest";
vi.mock(${JSON.stringify(import.meta.resolve("../src/infra/runtime-process-url.ts"))}, () => ({
  resolveRuntimeProcessEntrypointUrl: () => new URL("file:///synthetic/observer-process.js"),
}));
import { resolveRuntimeProcessEntrypointUrl } from ${JSON.stringify(import.meta.resolve("../src/infra/runtime-process-url.ts"))};
it("preserves failed custody while independent cleanup and the next file still run", async () => {
  const probeKey = Symbol.for("fixture.retainedAgentLease");
  const probe = Reflect.get(globalThis, probeKey);
  const resets = Reflect.get(globalThis, Symbol.for("openclaw.globalSingletonLifecycleResets"));
  try {
    expect(probe.afterAll).toBe(true);
    expect(probe.attempts, "file teardown must not retry the failed closer").toBe(1);
    expect(probe.database.db.isOpen).toBe(true);
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
    Reflect.deleteProperty(globalThis, probeKey);
    // Keep both singleton callbacks registered through observer teardown: the
    // successful callback must run again, while the failed callback must not.
  }
  expect(probe.attempts).toBe(2);
  expect(probe.database.db.isOpen).toBe(false);
  const owner = Reflect.get(globalThis, Symbol.for("openclaw.agentDatabaseLifecycle"));
  expect(owner.leases.has(probe.database.path)).toBe(false);
});
`,
  };
}

function stateReadPoolFixtureFiles(): Record<string, string> {
  return Object.fromEntries(
    ["a", "b", "c"].map((generation) => [
      `12-${generation}-state-read-pool.test.ts`,
      `
import fs from "node:fs";
import path from "node:path";
import { afterAll, expect, it, vi } from "vitest";
import { startAwaitedReadMock } from ${JSON.stringify(import.meta.resolve("../src/state/openclaw-state-read-mock.test-support.ts"))};
import { executeExistingOpenClawStateRead } from ${JSON.stringify(import.meta.resolve("../src/state/openclaw-state-db-readonly.ts"))};
import { readWorkspaceStateSnapshot } from ${JSON.stringify(import.meta.resolve("../src/agents/workspace-state-store.ts"))};
import { createWorkspaceStateIdentity } from ${JSON.stringify(import.meta.resolve("../src/agents/workspace-state-identity.ts"))};

const generation = ${JSON.stringify(generation)};
const probeKey = Symbol.for("fixture.stateReadPoolGenerations");
const probe = Reflect.get(globalThis, probeKey) ?? { closes: [] as string[], reads: [] as string[] };
Reflect.set(globalThis, probeKey, probe);
const edge = vi.hoisted(() => ({ create: vi.fn(), close: vi.fn(async () => {}) }));
vi.mock(${JSON.stringify(import.meta.resolve("../src/infra/worker-task-pool.ts"))}, async (importOriginal) => ({
  ...await importOriginal<typeof import(${JSON.stringify(import.meta.resolve("../src/infra/worker-task-pool.ts"))})>(),
  createOwnedWorkerTaskPool: edge.create,
}));
edge.close.mockImplementation(async () => { probe.closes.push(generation); });
edge.create.mockImplementation(() => ({
  startTask: () => {
    probe.reads.push(generation);
    return {
      ...startAwaitedReadMock(async () => generation === "c" ? {
        ok: true, type: "workspace.snapshot", sourceAdmitted: true,
        snapshot: { identity: createWorkspaceStateIdentity("/fixture/workspace"), setupExists: false, setup: { version: 1 } },
      } : { ok: true, type: "fleet.list", sourceAdmitted: true, cells: [] }),
      release: () => startAwaitedReadMock(async () => {}),
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

function sharedStateOwnerFixtureFiles(): Record<string, string> {
  return Object.fromEntries(
    ["a", "b"].map((generation) => [
      `09-${generation}-shared-state-owner.test.ts`,
      `
import fs from "node:fs";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { closeOpenClawStateDatabaseAsync } from ${JSON.stringify(import.meta.resolve("../src/state/openclaw-state-db-cache.ts"))};
import { captureOpenClawStateWorkerContext } from ${JSON.stringify(import.meta.resolve("../src/state/openclaw-state-worker-context.ts"))};
import { getOpenClawStateWorkerOwner } from ${JSON.stringify(import.meta.resolve("../src/state/openclaw-state-worker-owner.ts"))};

const generation = ${JSON.stringify(generation)};
const probeKey = Symbol.for("fixture.sharedStateOwnerGenerations");
const probe = Reflect.get(globalThis, probeKey) ?? { closes: [] as string[] };
Reflect.set(globalThis, probeKey, probe);
const edge = vi.hoisted(() => ({ open: vi.fn(), close: vi.fn(async () => {}) }));
vi.mock(${JSON.stringify(import.meta.resolve("../src/infra/sqlite-worker-store.ts"))}, () => ({
  openSharedStateSqliteWorkerStore: edge.open,
  closeUnclaimedSharedStateSqliteWorkers: async () => {},
  hasUnclaimedSharedStateSqliteCleanup: () => false,
  isSqliteWorkerStoreAvailable: () => true,
  getSqliteWorkerActorIdentity: (store) => store.actor,
  retireSqliteWorkerActor: async () => {},
  runSqliteWorkerStoreOperation: async (store, run) => run(store),
}));
edge.close.mockImplementation(async () => { probe.closes.push(generation); });
edge.open.mockImplementation(async (options, context) => ({
  close: edge.close,
  actor: { databasePath: options.databasePath, key: context.admission.identity.key },
}));

it("binds shared-state retirement to the current file's database lifecycle " + generation, async () => {
  const pathname = path.join(import.meta.dirname, "shared-" + generation + ".sqlite");
  // Only the transport is controlled; the real owner retains file identity and close custody.
  fs.writeFileSync(pathname, "synthetic shared-state source");
  const context = captureOpenClawStateWorkerContext({
    path: pathname, env: { OPENCLAW_STATE_DIR: import.meta.dirname },
  });
  const owner = getOpenClawStateWorkerOwner();
  try {
    expect(await owner.open(context)).toBeDefined();
    if (generation === "a") {
      expect(probe.closes).toEqual([]);
      // The file drain retires this resource before the next file is evaluated.
    } else {
      expect(probe.closes).toEqual(["a"]);
      await closeOpenClawStateDatabaseAsync();
      expect(probe.closes).toEqual(["a", "b"]);
    }
  } finally {
    if (generation === "b") {
      // A failed regression must still release the old owner's retained resource.
      await owner.close();
      Reflect.deleteProperty(globalThis, probeKey);
    }
  }
});
`,
    ]),
  );
}

function subagentRetirementFixtureFiles(): Record<string, string> {
  return {
    "10-c-subagent-registry.test.ts": `
import { expect, it, vi } from "vitest";
${unavailableSharedStateWorkerFixture}
import ${JSON.stringify(import.meta.resolve("../src/agents/subagents/registry/subagent-registry.ts"))};
import { subagentRuns } from ${JSON.stringify(import.meta.resolve("../src/agents/subagents/registry/subagent-registry-memory.ts"))};
import { createSubagentRunRecord } from ${JSON.stringify(import.meta.resolve("../src/agents/subagent-test-fixtures.test-helpers.ts"))};
it("leaves a retired-store delivery in its original registry generation", () => {
  const entry = createSubagentRunRecord({
    runId: "retired-registry-delivery", endedAt: 1, outcome: { status: "ok" },
    delivery: { status: "pending" },
  });
  subagentRuns.set(entry.runId, entry);
  subagentRuns.retireCompletionAuthority(entry);
  const api = Reflect.get(globalThis, Symbol.for("openclaw.subagentRegistryTestApi"));
  Reflect.set(globalThis, Symbol.for("fixture.retiredSubagentRegistry"), {
    runs: subagentRuns, tick: api.testing.runSweeperTickForTests,
  });
  expect(subagentRuns.size).toBe(1);
});
`,
    "10-d-subagent-registry-observer.test.ts": `
import { expect, it } from "vitest";
import ${JSON.stringify(import.meta.resolve("../src/state/openclaw-state-db-cache.ts"))};
it("prevents an old registry tick from recreating a worker against a retired cache", async () => {
  const key = Symbol.for("fixture.retiredSubagentRegistry");
  const previous = Reflect.get(globalThis, key);
  try {
    await previous.tick();
    expect(Reflect.has(globalThis, Symbol.for("openclaw.sharedStateWorkerOwner")),
      "retired registry recreated a shared-state worker owner").toBe(false);
    expect(previous.runs.size).toBe(0);
  } finally {
    Reflect.deleteProperty(globalThis, key);
  }
});
`,
  };
}
