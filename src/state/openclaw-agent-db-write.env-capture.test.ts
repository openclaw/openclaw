import { afterEach, expect, it, vi } from "vitest";
import { cloneEnvWithPlatformSemantics } from "../config/config-env-vars.js";
import type { SqliteIntegrityOperation } from "../infra/sqlite-integrity.js";
import { createDeferredCore } from "../shared/deferred.js";
import type { StoreWriterQueue } from "../shared/store-writer-queue.js";
import { withMockedPlatform } from "../test-utils/vitest-spies.js";
import type {
  OpenClawAgentDatabase,
  OpenClawAgentDatabaseOptions,
} from "./openclaw-agent-db-contract.js";
import type { PendingAgentDatabaseOpen } from "./openclaw-agent-db-lifecycle.js";
import { withOpenClawAgentDatabaseWrite } from "./openclaw-agent-db-write.js";
import {
  withOpenClawAgentDatabaseAdmission,
  withOpenClawAgentDatabaseAsync,
} from "./openclaw-agent-db.js";

const boundary = vi.hoisted(() => {
  const controls: { ready: Promise<void>; onIntegrity?: (signal?: AbortSignal) => void } = {
    ready: Promise.resolve(),
  };
  return {
    controls,
    integrity: vi.fn(async (_path: string, _timeout: number, signal?: AbortSignal) => {
      controls.onIntegrity?.(signal);
      await controls.ready;
      signal?.throwIfAborted();
    }),
    cache: {
      pending: new Map<string, PendingAgentDatabaseOpen>(),
      activePending: new Set<PendingAgentDatabaseOpen>(),
      databases: new Map<string, OpenClawAgentDatabase>(),
    },
    route: vi.fn(
      (options: OpenClawAgentDatabaseOptions) =>
        options.path ??
        `${options.env?.OPENCLAW_STATE_DIR ?? "/synthetic/default"}/${options.agentId}.sqlite`,
    ),
    admit: vi.fn(async (_options: OpenClawAgentDatabaseOptions, run: () => Promise<unknown>) => {
      await controls.ready;
      return await run();
    }),
    open: vi.fn((_options: OpenClawAgentDatabaseOptions) => {}),
  };
});

vi.mock("node:sqlite", () => ({
  DatabaseSync: class {
    readonly isOpen = true;
    location() {
      return null;
    }
  },
}));
vi.mock("../config/state-dir.js", () => ({
  resolveStateDir: (env: NodeJS.ProcessEnv) => env.OPENCLAW_STATE_DIR ?? "/synthetic/default",
}));
vi.mock("./openclaw-agent-db.paths.js", () => ({
  resolveOpenClawAgentSqlitePath: boundary.route,
}));
vi.mock("./openclaw-agent-write-admission.js", () => ({
  SQLITE_SESSION_WRITER_QUEUES: new Map<string, StoreWriterQueue>(),
  runOpenClawAgentWriteAdmission: boundary.admit,
}));
vi.mock("./openclaw-agent-db-lifecycle.js", () => ({
  agentDatabaseLifecycle: boundary.cache,
  retainAgentDatabase: vi.fn(() => vi.fn()),
}));
vi.mock("./agent-database-admission.js", () => ({
  assertAgentDatabaseAdmitted: vi.fn(),
}));
vi.mock("./agent-deletion-cleanup.js", () => ({
  assertAgentDeletionDatabaseCleanupAccess: vi.fn(),
  getAgentDeletionDatabaseCleanup: () => undefined,
}));
vi.mock("./openclaw-state-db-async-lifecycle.js", () => ({
  getOpenClawDatabaseMaintenanceScope: () => undefined,
  observeOpenClawDatabaseMaintenanceResource: vi.fn(),
}));
vi.mock("./openclaw-agent-db-schema-helpers.js", () => ({
  assertExistingAgentSchemaOwner: vi.fn(),
  assertSupportedAgentSchemaVersion: vi.fn(),
  readExistingAgentSchemaMeta: vi.fn(),
}));
vi.mock("../infra/sqlite-integrity-worker.js", () => ({
  assertSqliteIntegrityInWorker: boundary.integrity,
}));
vi.mock("../infra/sqlite-integrity.js", () => ({
  runSqliteIntegrityCheckSync: vi.fn(),
}));
vi.mock("../infra/sqlite-wal-write-admission.js", () => ({
  registerDeferredSqliteWalWriteAdmission: vi.fn(),
}));
vi.mock("./openclaw-agent-db.js", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const { createSqliteWalReclamationResult } = await import("../infra/sqlite-wal-reclamation.js");
  const { createOpenClawAgentDatabaseAdmissionOwner } =
    await import("./openclaw-agent-db-admission.js");
  const { registerOpenClawAgentDatabaseIdentity } = await import("./openclaw-agent-db-identity.js");
  const owner = createOpenClawAgentDatabaseAdmissionOwner(function* (
    options: OpenClawAgentDatabaseOptions,
  ): SqliteIntegrityOperation<OpenClawAgentDatabase> {
    const database = {
      agentId: options.agentId,
      path: boundary.route(options),
      db: new DatabaseSync(":memory:"),
      walMaintenance: {
        checkpoint: () => false,
        close: () => true,
        reclaimFreePages: createSqliteWalReclamationResult,
      },
    };
    registerOpenClawAgentDatabaseIdentity(database.db);
    yield { database: database.db, databaseLabel: database.path };
    boundary.open(options);
    boundary.cache.databases.set(database.path, database);
    return database;
  });
  return { ...owner, getOpenClawAgentDatabaseIfOpen: vi.fn() };
});

afterEach(() => {
  expect(boundary.cache.pending.size).toBe(0);
  expect(boundary.cache.activePending.size).toBe(0);
  boundary.cache.databases.clear();
  boundary.controls.ready = Promise.resolve();
  boundary.controls.onIntegrity = undefined;
  vi.clearAllMocks();
});

it.each([
  { driver: "write", platform: "win32", stateKey: "OpenClaw_State_Dir", input: "plain" },
  { driver: "write", platform: "win32", stateKey: "OpenClaw_State_Dir", input: "precloned" },
  { driver: "async", platform: "win32", stateKey: "OpenClaw_State_Dir", input: "plain" },
  { driver: "admission", platform: "win32", stateKey: "OpenClaw_State_Dir", input: "plain" },
  { driver: "write", platform: "linux", stateKey: "OPENCLAW_STATE_DIR", input: "plain" },
] as const)("pins $input environment through $driver capture on $platform", async (fixture) => {
  await withMockedPlatform(fixture.platform, async () => {
    const originalRoot = "/synthetic/captured";
    const rawEnv = { [fixture.stateKey]: originalRoot };
    const env = fixture.input === "precloned" ? cloneEnvWithPlatformSemantics(rawEnv) : rawEnv;
    const options = { agentId: "main", env };
    const ready = createDeferredCore();
    boundary.controls.ready = ready.promise;
    const mutate = vi.fn((database: OpenClawAgentDatabase) => database.path);
    const write =
      fixture.driver === "write"
        ? withOpenClawAgentDatabaseWrite(options, mutate)
        : fixture.driver === "async"
          ? withOpenClawAgentDatabaseAsync(options, mutate)
          : withOpenClawAgentDatabaseAdmission(
              options,
              async (run) => {
                await ready.promise;
                return await run(() => {});
              },
              mutate,
            );
    try {
      expect(boundary.route.mock.calls[0]?.[0].env?.OPENCLAW_STATE_DIR).toBe(originalRoot);
      expect(mutate).not.toHaveBeenCalled();
      if (fixture.driver === "write") {
        expect(boundary.admit.mock.calls[0]?.[0].env?.OPENCLAW_STATE_DIR).toBe(originalRoot);
        expect(boundary.open).not.toHaveBeenCalled();
      }

      env[fixture.stateKey] = "/synthetic/changed";
      options.env = { OPENCLAW_STATE_DIR: "/synthetic/replaced" };
      ready.resolve();

      await expect(write).resolves.toBe(`${originalRoot}/main.sqlite`);
      expect(boundary.open.mock.calls[0]?.[0].env?.OPENCLAW_STATE_DIR).toBe(originalRoot);
      expect(mutate).toHaveBeenCalledOnce();
    } finally {
      ready.resolve();
      await write.catch(() => undefined);
    }
  });
});

it("cancels one coalesced waiter without aborting the shared integrity check", async () => {
  const ready = createDeferredCore();
  const started = createDeferredCore<AbortSignal>();
  boundary.controls.ready = ready.promise;
  boundary.controls.onIntegrity = (signal) => {
    if (!signal) {
      throw new Error("Shared integrity check requires its owner's signal");
    }
    started.resolve(signal);
  };
  const first = vi.fn((database: OpenClawAgentDatabase) => database.path);
  const second = vi.fn((database: OpenClawAgentDatabase) => database.path);
  const options = { agentId: "main", path: "/synthetic/coalesced.sqlite" };
  const canceled = new AbortController();
  const stopped = Promise.allSettled([
    withOpenClawAgentDatabaseAsync(options, first, undefined, canceled.signal),
  ]);
  const remaining = withOpenClawAgentDatabaseAsync(options, second);
  try {
    const physicalSignal = await started.promise;
    const reason = new Error("Stop only the first waiter");
    canceled.abort(reason);
    expect(await stopped).toMatchObject([
      { status: "rejected", reason: { name: "AbortError", cause: reason } },
    ]);
    expect(physicalSignal.aborted).toBe(false);
    expect(first).not.toHaveBeenCalled();
    expect(second).not.toHaveBeenCalled();
    expect(boundary.open).not.toHaveBeenCalled();
    ready.resolve();
    await expect(remaining).resolves.toBe(options.path);
    expect(second).toHaveBeenCalledOnce();
    expect(boundary.integrity).toHaveBeenCalledOnce();
    expect(boundary.open).toHaveBeenCalledOnce();
  } finally {
    ready.resolve();
    await Promise.allSettled([stopped, remaining]);
  }
});
