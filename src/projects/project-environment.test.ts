import path from "node:path";
import { expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement } from "../../test/helpers/promise.js";

const mocks = vi.hoisted(() => ({
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
}));

vi.mock("node:fs/promises", () => ({
  default: {
    realpath: mocks.forbiddenFilesystem,
    stat: mocks.forbiddenFilesystem,
    rm: mocks.forbiddenFilesystem,
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
vi.mock("../state/openclaw-state-lease-worker-operation.js", () => ({
  runWithOpenClawStateLeaseWorker: async (
    _lease: unknown,
    context: unknown,
    run: (
      scope: { execute: (command: unknown) => Promise<unknown> },
      identity: { scope: string; key: string; owner: string },
    ) => Promise<unknown>,
  ) =>
    await run(
      { execute: async (command) => await mocks.execute(context, command) },
      { scope: "projects.checkout", key: "fixture-checkout", owner: "fixture-owner" },
    ),
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
vi.mock("./project-clone-runtime.js", () => ({
  ProjectCloneError: class extends Error {},
  cloneProjectCheckout: mocks.clone,
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

import { cloneEnvWithPlatformSemantics } from "../config/config-env-vars.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { migrateManagedWorktreeCanonicalWorkspaces } from "../config/sessions/worktree-workspace-migration.js";
import { sha256HexPrefixCore } from "../infra/crypto-digest.js";
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

type ProjectOperation = "remove" | "register" | "materialize" | "refresh";
type ProjectCommandName = "projects.insert" | "projects.remove" | "projects.resolveRefreshOwner";
type ProjectCommand = {
  [Name in ProjectCommandName]: { type: Name; input: OpenClawStateWorkerOperations[Name]["input"] };
}[ProjectCommandName];

const root = path.resolve("/synthetic-project-state");
const databasePath = path.join(root, "state", "openclaw.sqlite");
const environmentSnapshot = { OPENCLAW_STATE_DIR: root, OPENCLAW_SUPERVISOR_MODE: "external" };
const originUrl = "https://github.com/example/project.git";
const project: ProjectRegistryRecord = {
  id: "fixture-project",
  displayName: "Project",
  repoRoot: path.resolve("/synthetic-repository/project"),
  source: "cloned",
  originUrl,
};

it.each(
  (["remove", "register", "materialize", "refresh"] as const).flatMap((operation) =>
    (["plain", "precloned"] as const).map((environment) => ({ operation, environment })),
  ),
)(
  "retains $environment Windows state for $operation after caller changes",
  async ({ operation, environment }) => {
    await withMockedPlatform("win32", async () => {
      vi.clearAllMocks();
      const supplied: NodeJS.ProcessEnv = {
        OpenClaw_State_Dir: root,
        OpenClaw_Supervisor_Mode: "external",
      };
      const caller =
        environment === "precloned" ? cloneEnvWithPlatformSemantics(supplied) : supplied;
      const options = { env: caller };
      const entered = createDeferredCore();
      const resume = createDeferredCore();
      let paused = false;
      const pauseOnce = async () => {
        if (!paused) {
          paused = true;
          entered.resolve();
          await resume.promise;
        }
      };
      const lease: OpenClawStateLeaseContext = {
        signal: new AbortController().signal,
        assertOwned() {},
        assertOwnedInTransaction: mocks.forbiddenSqlite,
      };
      mocks.checkout.mockImplementation(async (_root, _options, run) => {
        await pauseOnce();
        return await run(lease);
      });
      mocks.lease.mockImplementation(async (_options, run) => {
        await pauseOnce();
        return await run(lease);
      });
      mocks.resolveCheckout.mockImplementation(async (repoRoot: string) => {
        await pauseOnce();
        return { repoRoot, originUrl: project.originUrl };
      });
      mocks.clone.mockResolvedValue(undefined);
      mocks.refresh.mockResolvedValue(undefined);
      mocks.read.mockResolvedValue({ ok: true, type: "projects.list", projects: [] });
      mocks.execute.mockImplementation(
        async (_context: OpenClawStateWorkerContext, command: ProjectCommand) => {
          switch (command.type) {
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
      const start: Record<ProjectOperation, () => Promise<unknown>> = {
        remove: () => removeProjectRegistry(project, options),
        register: () => registerProjectRegistry({ path: project.repoRoot }, options),
        materialize: () =>
          materializeProjectClone({ cfg: {}, gitUrl: originUrl, name: "Project" }, options),
        refresh: () => refreshProjectClone(project, options),
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
        if (operation === "materialize") {
          const target = path.join(root, "projects", sha256HexPrefixCore(originUrl, 16), "project");
          expect(result).toMatchObject({ id: project.id, repoRoot: target });
          expect(mocks.clone).toHaveBeenCalledWith(
            expect.objectContaining({ target }),
            expect.objectContaining({ env: expect.objectContaining({ OPENCLAW_STATE_DIR: root }) }),
          );
          expect(mocks.lease.mock.calls[0]?.[0].database.options.path).toBe(databasePath);
        } else if (operation === "register") {
          expect(result).toMatchObject({
            id: project.id,
            repoRoot: project.repoRoot,
            source: "registered",
          });
        } else if (operation === "remove") {
          expect(result).toBe(true);
        } else {
          expect(mocks.refresh).toHaveBeenCalledWith(
            { target: project.repoRoot, url: project.originUrl },
            expect.objectContaining({ env: expect.objectContaining({ OPENCLAW_STATE_DIR: root }) }),
          );
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

const repository = path.resolve("/synthetic-repository");
const sourceProject: ProjectRegistryRecord = {
  id: "registered-project",
  displayName: "Project",
  source: "registered",
  repoRoot: path.join(repository, "project"),
};

it.each(["selector", "migration"] as const)(
  "keeps the %s's Windows snapshot through awaited project resolution",
  async (operation) => {
    await withMockedPlatform("win32", async () => {
      vi.clearAllMocks();
      mocks.checkout.mockResolvedValue(undefined);
      mocks.listWorktrees.mockReturnValue([]);
      const env: NodeJS.ProcessEnv = {
        OpenClaw_State_Dir: root,
        OpenClaw_Supervisor_Mode: "external",
      };
      const entered = createDeferredCore<OpenClawStateWorkerContext>();
      const projectRead = createDeferredCore<ProjectRegistryRecord>();
      mocks.execute.mockImplementation(async (context: OpenClawStateWorkerContext) => {
        entered.resolve(context);
        return await projectRead.promise;
      });
      const agentDatabasePath = path.resolve("/synthetic-agent/openclaw.sqlite");
      const entry: SessionEntry = {
        sessionId: "env-migration",
        updatedAt: 1,
        projectId: sourceProject.id,
        worktree: { id: "worktree", branch: "task", repoRoot: repository },
      };
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
      const pending =
        operation === "selector"
          ? selectStoredProjectRegistry(sourceProject.id, { env }).then(async (selected) => {
              expect(selected?.project).toEqual(sourceProject);
              await selected?.withRollback(async () => undefined);
              const options = mocks.checkout.mock.calls[0]?.[1];
              expect(options).toMatchObject({
                path: path.join(root, "state", "openclaw.sqlite"),
                env: { OPENCLAW_SUPERVISOR_MODE: "external" },
              });
              return options?.env;
            })
          : migrateManagedWorktreeCanonicalWorkspaces({
              mode: "doctor-fix",
              agentId: "main",
              cfg: {},
              env,
              storePath: agentDatabasePath,
            }).then((result) => {
              expect(result).toEqual({ found: 1, repaired: 1 });
              expect(mocks.listWorktrees.mock.calls[0]?.[0].OPENCLAW_STATE_DIR).toBe(root);
              expect(env.OpenClaw_State_Dir).toBe(path.resolve("/changed-project-state"));
              expect(Object.hasOwn(env, "OPENCLAW_STATE_DIR")).toBe(false);
              return mocks.patch.mock.calls[0]?.[0].env;
            });
      const joined = pending.catch(() => {});
      try {
        const context = await awaitGateBeforeSettlement(entered.promise, pending, "Read bypassed");
        env.OpenClaw_State_Dir = path.resolve("/changed-project-state");
        env.OpenClaw_Supervisor_Mode = "other";
        projectRead.resolve(sourceProject);
        const snapshot: NodeJS.ProcessEnv | undefined = await pending;
        expect(snapshot?.OPENCLAW_STATE_DIR).toBe(root);
        expect(snapshot).not.toBe(env);
        expect(Object.keys(snapshot ?? {})).toContain("OpenClaw_State_Dir");
        expect(Object.keys(snapshot ?? {})).not.toContain("OPENCLAW_STATE_DIR");
        expect(context.environment).toEqual({
          OPENCLAW_STATE_DIR: root,
          OPENCLAW_SUPERVISOR_MODE: "external",
        });
        expect(context.admission.databasePath).toBe(path.join(root, "state", "openclaw.sqlite"));
        expect(mocks.forbiddenSqlite).not.toHaveBeenCalled();
      } finally {
        projectRead.resolve(sourceProject);
        await joined;
      }
    });
  },
);
