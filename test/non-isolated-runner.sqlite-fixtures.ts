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
  return {
    ...stateReadPoolFixtureFiles(repoRoot),
    "11-a-sqlite-owner.test.ts": `
import { afterAll, expect, it, vi } from "vitest";
import path from "node:path";
vi.mock(${source("infra/runtime-worker-url.ts")}, () => ({
  resolveRuntimeWorkerUrl: () => new URL("file:///synthetic/shared-state.worker.js"),
}));
import { isSqliteWorkerStoreAvailable } from ${source("infra/sqlite-worker-store.ts")};
import { registerOpenClawStateDatabaseAsyncResource } from ${source("state/openclaw-state-db-cache.ts")};
import { openOpenClawStateWorkerCleanupStore } from ${source("state/openclaw-state-worker-store.ts")};
import { openOpenClawAgentDatabase } from ${source("state/openclaw-agent-db.ts")};
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
