import path from "node:path";
import { expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  execute: vi.fn(),
  checkout: vi.fn(),
  lease: vi.fn(),
  resolveCheckout: vi.fn(),
  clone: vi.fn(),
  refresh: vi.fn(),
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
vi.mock("../state/openclaw-state-lease-worker-storage.js", () => ({
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
vi.mock("../infra/state-database-coordinator.js", () => ({
  captureStateDatabaseCoordinatorRuntime: () => ({
    directory: "/synthetic-coordinator",
    keepAlive: false,
  }),
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

import { cloneEnvWithPlatformSemantics } from "../config/config-env-vars.js";
import { sha256HexPrefixCore } from "../infra/crypto-digest.js";
import { createDeferredCore } from "../shared/deferred.js";
import type { OpenClawStateLeaseContext } from "../state/openclaw-state-lease.js";
import type { OpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.types.js";
import type { OpenClawStateWorkerOperations } from "../state/openclaw-state-worker-contract.js";
import { withMockedPlatform } from "../test-utils/vitest-spies.js";
import { materializeProjectClone, refreshProjectClone } from "./project-clone.js";
import { registerResolvedProject } from "./project-registration.js";
import { removeProjectRegistry } from "./project-registry.js";
import type { ProjectRegistryRecord } from "./project-registry.kernel.js";

type ProjectOperation = "remove" | "register" | "materialize" | "refresh";
type ProjectCommandName =
  | "projects.list"
  | "projects.insert"
  | "projects.remove"
  | "projects.resolveRefreshOwner";
type ProjectCommand = {
  [Name in ProjectCommandName]: { type: Name; input: OpenClawStateWorkerOperations[Name]["input"] };
}[ProjectCommandName];

const root = path.resolve("/synthetic-project-state");
const databasePath = path.join(root, "state", "openclaw.sqlite");
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
        HOME: path.resolve("/synthetic-home"),
        USERPROFILE: path.resolve("/synthetic-home"),
        NODE_ENV: "test",
        OPENCLAW_TEST_FAST: "1",
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
      mocks.execute.mockImplementation(
        async (_context: OpenClawStateWorkerContext, command: ProjectCommand) => {
          switch (command.type) {
            case "projects.list":
              return [];
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
        register: () =>
          registerResolvedProject({ path: project.repoRoot, source: "registered" }, options),
        materialize: () =>
          materializeProjectClone({ cfg: {}, gitUrl: originUrl, name: "Project" }, options),
        refresh: () => refreshProjectClone(project, options),
      };
      const pending = start[operation]();
      const joined = pending.then(
        () => undefined,
        () => undefined,
      );
      try {
        await Promise.race([
          entered.promise,
          pending.then(() => {
            throw new Error("Project operation completed before its awaited boundary");
          }),
        ]);
        caller.OpenClaw_State_Dir = path.resolve("/mutated-project-state");
        caller.OpenClaw_Supervisor_Mode = "internal";
        options.env = { ...caller, OpenClaw_State_Dir: path.resolve("/replaced-project-state") };
        resume.resolve();
        const result = await pending;
        expect(mocks.execute).toHaveBeenCalled();
        for (const [context] of mocks.execute.mock.calls) {
          expect(context.environment).toEqual({
            OPENCLAW_STATE_DIR: root,
            OPENCLAW_SUPERVISOR_MODE: "external",
          });
          expect(context.admission.databasePath).toBe(databasePath);
        }
        for (const [, captured] of mocks.checkout.mock.calls) {
          expect(captured.path).toBe(databasePath);
          expect(captured.env.OPENCLAW_STATE_DIR).toBe(root);
          expect(captured.env.OPENCLAW_SUPERVISOR_MODE).toBe("external");
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
