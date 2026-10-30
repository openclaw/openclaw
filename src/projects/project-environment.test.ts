import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement } from "../../test/helpers/promise.js";

const mocks = vi.hoisted(() => {
  const lease = () => ({
    signal: new AbortController().signal,
    assertCurrent: vi.fn(),
    assertOwned: vi.fn(),
    assertOwnedInTransaction: vi.fn(),
  });
  return {
    originLease: lease(),
    checkoutLease: lease(),
    checkouts: new Set<string>(),
    finishWorker: vi.fn<() => void>(),
    finishCheckout: vi.fn<() => void>(),
    remove: vi.fn<(target: string) => Promise<void>>(),
    execute: vi.fn(),
    read: vi.fn(),
    checkout: vi.fn(),
    lease: vi.fn(),
    resolveCheckout: vi.fn(),
    clone: vi.fn(),
    refresh: vi.fn(),
    listWorktrees: vi.fn(),
    readAgent: vi.fn(),
    patch: vi.fn(),
    forbiddenSqlite: vi.fn(() => {
      throw new Error("Project environment tests must not open SQLite");
    }),
    forbiddenFilesystem: vi.fn(() => {
      throw new Error("Project environment tests must not access the filesystem");
    }),
  };
});

vi.mock("node:fs/promises", () => ({
  default: {
    realpath: mocks.forbiddenFilesystem,
    stat: mocks.forbiddenFilesystem,
    rm: mocks.remove,
    rmdir: mocks.forbiddenFilesystem,
  },
}));

vi.mock("../agents/agent-scope-config.js", () => ({
  withAgentRosterFactsBatch: (_config: unknown, run: () => unknown) => run(),
}));
vi.mock("../agents/agent-scope.js", () => ({
  listAgentIds: () => [],
  resolveAgentWorkspaceDir: vi.fn(),
}));
vi.mock("../infra/node-sqlite.js", () => ({
  openNodeSqliteDatabase: mocks.forbiddenSqlite,
}));
vi.mock("../infra/kysely-sync.js", () => ({
  executeSqliteQuerySync: mocks.forbiddenSqlite,
  executeSqliteQueryTakeFirstSync: mocks.forbiddenSqlite,
  getNodeSqliteKysely: mocks.forbiddenSqlite,
}));
vi.mock("../state/openclaw-state-db.js", () => ({
  openOpenClawStateDatabase: mocks.forbiddenSqlite,
  runOpenClawStateWriteTransaction: mocks.forbiddenSqlite,
}));
vi.mock("../state/openclaw-state-lease.js", () => ({
  withOpenClawStateLease: mocks.lease,
}));
vi.mock("../state/openclaw-state-worker-store.js", () => ({
  executeOpenClawStateWorker: mocks.execute,
}));
// mock-isolation: Capture Windows environment routing without opening SQLite or touching disk.
vi.mock("../state/openclaw-state-db-readonly.js", () => ({
  executeExistingOpenClawStateRead: mocks.read,
}));
// mock-isolation: synthetic worker callbacks preserve finalizer ordering without native writes.
vi.mock("../state/openclaw-state-lease-worker-operation.js", () => ({
  runWithOpenClawStateLeaseWorker: async (
    _lease: unknown,
    context: unknown,
    run: (
      scope: { execute: (command: unknown) => Promise<unknown> },
      identity: { scope: string; key: string; owner: string },
    ) => Promise<unknown>,
  ) => {
    const result = await run(
      { execute: async (command) => await mocks.execute(context, command) },
      { scope: "projects.checkout", key: "fixture-checkout", owner: "fixture-owner" },
    );
    mocks.finishWorker();
    return result;
  },
}));
vi.mock("../state/openclaw-state-db-cache.js", () => ({
  captureOpenClawStateDatabaseReadAdmission: (databasePath: string) => ({
    databasePath,
    assertCurrent() {},
  }),
}));
vi.mock("../state/openclaw-state-db-async-lifecycle.js", () => ({
  getOpenClawDatabaseMaintenanceScope: () => undefined,
}));
vi.mock("./project-checkout.js", () => ({
  ProjectCheckoutError: class extends Error {},
  withProjectCheckoutLifecycle: mocks.checkout,
  resolveProjectCheckout: mocks.resolveCheckout,
  resolveProjectDirectory: async (directory: string) => directory,
}));
// mock-isolation: registration reads only the synthetic checkout's origin.
vi.mock("../agents/worktrees/git.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../agents/worktrees/git.js")>()),
  runGit: async () => ({ code: 0, stdout: "https://github.com/example/project.git" }),
}));
// mock-isolation: environment routing must not spawn Git against synthetic checkout paths.
vi.mock("./project-clone-runtime.js", () => ({
  ProjectCloneError: class extends Error {},
  cloneProjectCheckout: mocks.clone,
  configureProjectCheckoutMaintenance: vi.fn(),
  refreshProjectCheckout: mocks.refresh,
  ensureProjectCheckoutCommit: vi.fn(),
}));
vi.mock("./project-registry.kernel.js", () => ({
  ensureProjectRegistrySchema: mocks.forbiddenSqlite,
  removeProjectCheckoutReferenceInDatabase: mocks.forbiddenSqlite,
}));

// mock-isolation: migration uses a synthetic worktree inventory, never host state.
vi.mock("../agents/worktrees/registry.js", () => ({
  listRegistryWorktreesForMigration: mocks.listWorktrees,
}));
// mock-isolation: return synthetic sessions without opening the host agent database.
vi.mock("../state/openclaw-agent-db-readonly.js", () => ({
  withOpenClawAgentDatabaseReadOnly: mocks.readAgent,
}));
// mock-isolation: observe migration writes without mutating real sessions.
vi.mock("../config/sessions/session-accessor.js", () => ({ patchSessionEntryCore: mocks.patch }));
// mock-isolation: retain synthetic scope options and reject native database access.
vi.mock("../config/sessions/session-accessor.sqlite-scope.js", () => ({
  resolveSqliteScope: (scope: unknown) => scope,
  toDatabaseOptions: (scope: unknown) => scope,
  getSessionKysely: mocks.forbiddenSqlite,
}));
// mock-isolation: the fixture supplies parsed entries; native row decoding is forbidden.
vi.mock("../config/sessions/session-accessor.sqlite-entry-store.js", () => ({
  parseReadableSqliteSessionEntryRow: mocks.forbiddenSqlite,
}));

import type { SessionEntry } from "../config/sessions/types.js";
import { migrateManagedWorktreeCanonicalWorkspaces } from "../config/sessions/worktree-workspace-migration.js";
import { sha256HexPrefixCore } from "../infra/crypto-digest.js";
import type { SqliteWorkerCommand } from "../infra/sqlite-worker-contract.js";
import { createDeferredCore } from "../shared/deferred.js";
import type { OpenClawStateLeaseContext } from "../state/openclaw-state-lease.js";
import type { OpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.types.js";
import type { OpenClawStateWorkerOperations } from "../state/openclaw-state-worker-contract.js";
import { withMockedPlatform } from "../test-utils/vitest-spies.js";
import { materializeProjectClone, refreshProjectClone } from "./project-clone.js";
import {
  registerProjectRegistry,
  removeProjectRegistry,
  selectStoredProjectRegistry,
} from "./project-registry.js";
import type { ProjectRegistryRecord } from "./project-registry.types.js";

beforeEach(() => {
  vi.resetAllMocks();
  mocks.forbiddenSqlite.mockImplementation(() => {
    throw new Error("Project tests must not open SQLite");
  });
  mocks.forbiddenFilesystem.mockImplementation(() => {
    throw new Error("Project tests must not access the filesystem");
  });
  mocks.remove.mockImplementation(mocks.forbiddenFilesystem);
});

type LeaseRun = (lease: OpenClawStateLeaseContext) => Promise<unknown>;

const root = path.resolve("/synthetic-project-state");
const databasePath = path.join(root, "state", "openclaw.sqlite");
const environmentSnapshot = { OPENCLAW_STATE_DIR: root, OPENCLAW_SUPERVISOR_MODE: "external" };
const originUrl = "https://github.com/example/project.git";
const repository = path.resolve("/synthetic-repository");
const project: ProjectRegistryRecord = {
  id: "fixture-project",
  displayName: "Project",
  repoRoot: path.join(repository, "project"),
  source: "cloned",
  originUrl,
};
const sourceProject: ProjectRegistryRecord = {
  id: "registered-project",
  displayName: "Project",
  repoRoot: project.repoRoot,
  source: "registered",
};
it.each(["remove", "register", "materialize", "refresh", "selector", "migration"] as const)(
  "retains Windows state for %s after caller changes",
  async (operation) => {
    await withMockedPlatform("win32", async () => {
      const caller: NodeJS.ProcessEnv = {
        OpenClaw_State_Dir: root,
        OpenClaw_Supervisor_Mode: "external",
      };
      const options = { env: caller };
      const entered = createDeferredCore();
      const resume = createDeferredCore();
      const source = operation === "selector" || operation === "migration";
      const pauseOnce = vi.fn().mockImplementationOnce(async () => {
        entered.resolve();
        await resume.promise;
      });
      const lease: OpenClawStateLeaseContext = {
        ...mocks.checkoutLease,
        assertOwnedInTransaction: mocks.forbiddenSqlite,
      };
      mocks.checkout.mockImplementation(async (_root, _options, run) => {
        if (source) {
          return undefined;
        }
        await pauseOnce();
        return await run(lease);
      });
      mocks.lease.mockImplementation(async (_options, run) => {
        await pauseOnce();
        return await run(lease);
      });
      mocks.resolveCheckout.mockImplementation(async (repoRoot: string) => {
        await pauseOnce();
        return { repoRoot, originUrl };
      });
      mocks.clone.mockResolvedValue(undefined);
      mocks.refresh.mockResolvedValue(undefined);
      mocks.read.mockResolvedValue({ ok: true, type: "projects.list", projects: [] });
      mocks.execute.mockImplementation(
        async (
          _context: OpenClawStateWorkerContext,
          command: SqliteWorkerCommand<OpenClawStateWorkerOperations>,
        ) => {
          switch (command.type) {
            case "projects.resolve":
              await pauseOnce();
              return sourceProject;
            case "projects.insert":
              return { id: project.id, ...command.input.project };
            case "projects.remove":
              return true;
            case "projects.resolveRefreshOwner":
              return project;
            default:
              throw new Error("Unexpected Projects worker command");
          }
        },
      );
      const agentDatabasePath = path.resolve("/synthetic-agent/openclaw.sqlite");
      if (operation === "migration") {
        const entry: SessionEntry = {
          sessionId: "env-migration",
          updatedAt: 1,
          projectId: sourceProject.id,
          worktree: { id: "worktree", branch: "task", repoRoot: repository },
        };
        mocks.listWorktrees.mockReturnValue([]);
        mocks.readAgent.mockReturnValue({
          found: true,
          value: [
            {
              databasePath: agentDatabasePath,
              entry,
              sessionKey: "agent:main:dashboard:env-migration",
            },
          ],
        });
        mocks.patch.mockImplementation(
          async (
            _scope: { env?: NodeJS.ProcessEnv },
            update: (current: SessionEntry) => Partial<SessionEntry> | null,
          ) => ({ ...entry, ...update(entry) }),
        );
      }
      const start: Record<typeof operation, () => Promise<unknown>> = {
        remove: () => removeProjectRegistry(project, options),
        register: () => registerProjectRegistry({ path: project.repoRoot }, options),
        materialize: () =>
          materializeProjectClone({ cfg: {}, gitUrl: originUrl, name: "Project" }, options),
        refresh: () => refreshProjectClone(project, options),
        selector: async () => {
          const selected = await selectStoredProjectRegistry(sourceProject.id, options);
          expect(selected?.project).toEqual(sourceProject);
          await selected?.withRollback(async () => undefined);
          return mocks.checkout.mock.calls[0]?.[1].env;
        },
        migration: async () => {
          expect(
            await migrateManagedWorktreeCanonicalWorkspaces({
              mode: "doctor-fix",
              agentId: "main",
              cfg: {},
              env: caller,
              storePath: agentDatabasePath,
            }),
          ).toEqual({ found: 1, repaired: 1 });
          expect(mocks.listWorktrees.mock.calls[0]?.[0].OPENCLAW_STATE_DIR).toBe(root);
          expect(Object.hasOwn(caller, "OPENCLAW_STATE_DIR")).toBe(false);
          return mocks.patch.mock.calls[0]?.[0].env;
        },
      };
      const pending = start[operation]();
      const joined = pending.catch(() => {});
      try {
        await awaitGateBeforeSettlement(entered.promise, pending, "Project boundary was bypassed");
        caller.OpenClaw_State_Dir = path.resolve("/mutated-project-state");
        caller.OpenClaw_Supervisor_Mode = "internal";
        options.env = { ...caller, OpenClaw_State_Dir: path.resolve("/replaced-project-state") };
        resume.resolve();
        const result = await pending;
        expect(mocks.execute).toHaveBeenCalled();
        for (const [context] of mocks.execute.mock.calls) {
          expect(context.environment).toEqual(environmentSnapshot);
          expect(context.admission.databasePath).toBe(databasePath);
        }
        for (const [readOptions, , { context }] of mocks.read.mock.calls) {
          expect(readOptions.path).toBe(databasePath);
          expect(context.environment).toEqual(environmentSnapshot);
        }
        for (const [, captured] of mocks.checkout.mock.calls) {
          expect(captured).toMatchObject({ path: databasePath, env: environmentSnapshot });
          expect(captured.env).not.toBe(caller);
        }
        for (const [, captured] of [...mocks.clone.mock.calls, ...mocks.refresh.mock.calls]) {
          expect(captured.env).toMatchObject({ OPENCLAW_STATE_DIR: root });
        }
        if (source) {
          expect(result).toHaveProperty("OPENCLAW_STATE_DIR", root);
          expect(result).not.toBe(caller);
          expect(Object.keys(result ?? {})).toContain("OpenClaw_State_Dir");
          expect(Object.keys(result ?? {})).not.toContain("OPENCLAW_STATE_DIR");
        } else if (operation === "materialize") {
          const target = path.join(root, "projects", sha256HexPrefixCore(originUrl, 16), "project");
          expect(result).toMatchObject({ repoRoot: target });
          expect(mocks.clone.mock.calls[0]?.[0].target).toBe(target);
          expect(mocks.lease.mock.calls[0]?.[0].database.options.path).toBe(databasePath);
        } else if (operation === "refresh") {
          expect(mocks.refresh.mock.calls[0]?.[0]).toEqual({
            target: project.repoRoot,
            url: originUrl,
          });
        }
        expect(caller.OpenClaw_State_Dir).toBe(path.resolve("/mutated-project-state"));
        expect(mocks.forbiddenSqlite).not.toHaveBeenCalled();
        expect(mocks.forbiddenFilesystem).not.toHaveBeenCalled();
      } finally {
        resume.resolve();
        await joined;
      }
    });
  },
);

describe("clone registration", () => {
  const materialize = () =>
    materializeProjectClone(
      { cfg: {}, gitUrl: "https://github.com/example/project.git" },
      { env: { OPENCLAW_STATE_DIR: "/synthetic/state" } },
    );

  beforeEach(() => {
    mocks.checkouts.clear();
    mocks.read.mockResolvedValue({ ok: true, type: "projects.list", projects: [] });
    mocks.lease.mockImplementation(async (_options: unknown, run: LeaseRun) =>
      run(mocks.originLease),
    );
    mocks.resolveCheckout.mockImplementation(async (repoRoot: string) => ({
      path: repoRoot,
      repoRoot,
    }));
    mocks.checkout.mockImplementation(async (_root: string, _options: unknown, run: LeaseRun) => {
      const result = await run(mocks.checkoutLease);
      mocks.finishCheckout();
      return result;
    });
    mocks.clone.mockImplementation(async ({ target }) => void mocks.checkouts.add(target));
    mocks.remove.mockImplementation(async (target) => void mocks.checkouts.delete(target));
    mocks.execute.mockImplementation(async () => {
      const repoRoot = [...mocks.checkouts][0];
      if (!repoRoot) {
        throw new Error("Expected a produced checkout");
      }
      return { ...project, id: "project", displayName: "project", repoRoot };
    });
  });

  it("returns an acknowledged registration and retains its checkout", async () => {
    const registered = await materialize();
    expect(mocks.checkouts).toEqual(new Set([registered.repoRoot]));
    expect(mocks.remove).not.toHaveBeenCalled();
  });

  it.each([
    "unknown",
    "worker",
    "finalizer",
    "precommit",
    "removal",
    "origin",
    "checkout",
  ] as const)("settles registration after %s failure", async (stage) => {
    let failure: Error = new Error(`${stage} failed`);
    if (stage === "unknown") {
      const unknown = Object.assign(new Error("Worker result unavailable"), {
        name: "SqliteWorkerError",
        code: "outcome-unknown",
      });
      failure = new AggregateError([unknown, new Error("Retirement failed")], "Cleanup failed");
    }
    const fail = () => {
      throw failure;
    };
    if (stage === "worker" || stage === "finalizer") {
      const finish = stage === "worker" ? mocks.finishWorker : mocks.finishCheckout;
      finish.mockImplementation(fail);
    } else {
      mocks.execute.mockImplementation(async () => {
        if (stage === "origin" || stage === "checkout") {
          const lease = stage === "origin" ? mocks.originLease : mocks.checkoutLease;
          lease.assertOwned.mockImplementation(() => {
            throw new Error("Owner is no longer current");
          });
        }
        return fail();
      });
    }
    if (stage === "removal") {
      mocks.remove.mockRejectedValue(new Error("Checkout removal failed"));
    }
    await expect(materialize()).rejects.toBe(failure);
    expect(mocks.checkouts.size).toBe(stage === "precommit" ? 0 : 1);
    const removals = stage === "precommit" || stage === "removal" ? 1 : 0;
    expect(mocks.remove).toHaveBeenCalledTimes(removals);
  });
});
