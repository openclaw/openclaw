import path from "node:path";
import { expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement } from "../../test/helpers/promise.js";

const mocks = vi.hoisted(() => ({
  execute: vi.fn(),
  checkout: vi.fn(),
  listWorktrees: vi.fn(),
  readAgent: vi.fn(),
  patch: vi.fn(),
  forbiddenSqlite: vi.fn(() => {
    throw new Error("Project environment controls must not open SQLite");
  }),
}));

vi.mock("../agents/agent-scope-config.js", () => ({ withAgentRosterFactsBatch: vi.fn() }));
vi.mock("../agents/agent-scope.js", () => ({
  listAgentIds: vi.fn(),
  resolveAgentWorkspaceDir: vi.fn(),
}));
// mock-isolation: this boundary must reject any attempt to open SQLite on the host.
vi.mock("../infra/node-sqlite.js", () => ({ openNodeSqliteDatabase: mocks.forbiddenSqlite }));
vi.mock("../state/openclaw-state-worker-store.js", () => ({
  executeOpenClawStateWorker: mocks.execute,
}));
vi.mock("./project-checkout.js", () => ({
  withProjectCheckoutLifecycle: mocks.checkout,
  ProjectCheckoutError: class extends Error {},
  resolveProjectCheckout: vi.fn(),
  resolveProjectDirectory: vi.fn(),
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
vi.mock("../state/openclaw-state-db.js", () => ({
  runOpenClawStateWriteTransaction: mocks.forbiddenSqlite,
}));
vi.mock("./project-registry.kernel.js", () => ({
  ensureProjectRegistrySchema: mocks.forbiddenSqlite,
  removeProjectCheckoutReferenceInDatabase: mocks.forbiddenSqlite,
}));
vi.mock("../agents/worktrees/registry.js", () => ({
  listRegistryWorktreesForMigration: mocks.listWorktrees,
}));
vi.mock("../state/openclaw-agent-db-readonly.js", () => ({
  withOpenClawAgentDatabaseReadOnly: mocks.readAgent,
}));
vi.mock("../config/sessions/session-accessor.js", () => ({ patchSessionEntryCore: mocks.patch }));
vi.mock("../config/sessions/session-accessor.sqlite-scope.js", () => ({
  resolveSqliteScope: (scope: unknown) => scope,
  toDatabaseOptions: (scope: unknown) => scope,
  getSessionKysely: mocks.forbiddenSqlite,
}));
vi.mock("../config/sessions/session-accessor.sqlite-entry-store.js", () => ({
  parseReadableSqliteSessionEntryRow: mocks.forbiddenSqlite,
}));
vi.mock("../infra/kysely-sync.js", () => ({ executeSqliteQuerySync: mocks.forbiddenSqlite }));

import type { SessionEntry } from "../config/sessions/types.js";
import { migrateManagedWorktreeCanonicalWorkspaces } from "../config/sessions/worktree-workspace-migration.js";
import { createDeferredCore } from "../shared/deferred.js";
import type { OpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.types.js";
import { withMockedPlatform } from "../test-utils/vitest-spies.js";
import { selectStoredProjectRegistry } from "./project-registry.js";
import type { ProjectRegistryRecord } from "./project-registry.types.js";

const root = path.resolve("/synthetic-project-state");
const repository = path.resolve("/synthetic-repository");
const project: ProjectRegistryRecord = {
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
      const databasePath = path.resolve("/synthetic-agent/openclaw.sqlite");
      const entry: SessionEntry = {
        sessionId: "env-migration",
        updatedAt: 1,
        projectId: project.id,
        worktree: { id: "worktree", branch: "task", repoRoot: repository },
      };
      mocks.readAgent.mockReturnValue({
        found: true,
        value: [{ databasePath, entry, sessionKey: "agent:main:dashboard:env-migration" }],
      });
      mocks.patch.mockImplementation(
        async (
          _scope: { env?: NodeJS.ProcessEnv },
          update: (current: SessionEntry) => Partial<SessionEntry> | null,
        ) => ({ ...entry, ...update(entry) }),
      );
      const pending =
        operation === "selector"
          ? selectStoredProjectRegistry(project.id, { env }).then(async (selected) => {
              expect(selected?.project).toEqual(project);
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
              storePath: databasePath,
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
        projectRead.resolve(project);
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
        projectRead.resolve(project);
        await joined;
      }
    });
  },
);
