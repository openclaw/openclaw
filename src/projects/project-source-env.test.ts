import path from "node:path";
import { beforeEach, expect, it, vi } from "vitest";

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
vi.mock("../infra/node-sqlite.js", () => ({
  openNodeSqliteDatabase: mocks.forbiddenSqlite,
}));
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
vi.mock("./project-registration.js", () => ({ registerResolvedProject: vi.fn() }));
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
import { selectStoredProjectRegistry } from "./project-registry.js";
import type { ProjectRegistryRecord } from "./project-registry.kernel.js";

const root = path.resolve("/synthetic-project-state");
const project: ProjectRegistryRecord = {
  id: "registered-project",
  displayName: "Project",
  source: "registered",
  repoRoot: path.resolve("/synthetic-repository/project"),
};

function callerEnvironment(): NodeJS.ProcessEnv {
  return {
    HOME: path.resolve("/synthetic-home"),
    USERPROFILE: path.resolve("/synthetic-home"),
    NODE_ENV: "test",
    OPENCLAW_TEST_FAST: "1",
    OpenClaw_State_Dir: root,
    OpenClaw_Supervisor_Mode: "external",
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.checkout.mockResolvedValue(undefined);
  mocks.listWorktrees.mockReturnValue([]);
});

it("keeps the selector's Windows state snapshot through a caller environment change", async () => {
  const platform = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
  const env = callerEnvironment();
  const entered = createDeferredCore();
  const projectRead = createDeferredCore<ProjectRegistryRecord>();
  let captured: OpenClawStateWorkerContext | undefined;
  mocks.execute.mockImplementation(async (context: OpenClawStateWorkerContext) => {
    captured = context;
    entered.resolve();
    return await projectRead.promise;
  });
  const selection = selectStoredProjectRegistry(project.id, { env });
  const joined = selection.then(
    () => undefined,
    () => undefined,
  );
  try {
    await Promise.race([
      entered.promise,
      selection.then(() => {
        throw new Error("Selection completed before the project read");
      }),
    ]);
    env.OpenClaw_State_Dir = path.resolve("/changed-project-state");
    env.OpenClaw_Supervisor_Mode = "other";
    projectRead.resolve(project);
    const selected = await selection;
    expect(selected?.project).toEqual(project);
    expect(captured?.environment).toEqual({
      OPENCLAW_STATE_DIR: root,
      OPENCLAW_SUPERVISOR_MODE: "external",
    });
    expect(captured?.admission.databasePath).toBe(path.join(root, "state", "openclaw.sqlite"));
    await selected?.withRollback(async () => undefined);
    const checkoutOptions = mocks.checkout.mock.calls[0]?.[1];
    expect(checkoutOptions?.path).toBe(path.join(root, "state", "openclaw.sqlite"));
    expect(checkoutOptions?.env.OPENCLAW_STATE_DIR).toBe(root);
    expect(checkoutOptions?.env.OPENCLAW_SUPERVISOR_MODE).toBe("external");
    expect(checkoutOptions?.env).not.toBe(env);
    expect(Object.keys(checkoutOptions.env)).toContain("OpenClaw_State_Dir");
    expect(Object.keys(checkoutOptions.env)).not.toContain("OPENCLAW_STATE_DIR");
    expect(mocks.forbiddenSqlite).not.toHaveBeenCalled();
  } finally {
    projectRead.resolve(project);
    await joined;
    platform.mockRestore();
  }
});

it("keeps the migration's Windows state snapshot through the awaited project resolution", async () => {
  const platform = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
  const env = callerEnvironment();
  const entered = createDeferredCore();
  const projectRead = createDeferredCore<ProjectRegistryRecord>();
  const sessionKey = "agent:main:dashboard:env-migration";
  const databasePath = path.resolve("/synthetic-agent/openclaw.sqlite");
  const entry: SessionEntry = {
    sessionId: "env-migration",
    updatedAt: 1,
    projectId: project.id,
    worktree: { id: "worktree", branch: "task", repoRoot: path.resolve("/synthetic-repository") },
  };
  let captured: OpenClawStateWorkerContext | undefined;
  let patchEnv: NodeJS.ProcessEnv | undefined;
  mocks.readAgent.mockReturnValue({ found: true, value: [{ databasePath, entry, sessionKey }] });
  mocks.execute.mockImplementation(async (context: OpenClawStateWorkerContext) => {
    captured = context;
    entered.resolve();
    return await projectRead.promise;
  });
  mocks.patch.mockImplementation(
    async (
      scope: { env?: NodeJS.ProcessEnv },
      update: (current: SessionEntry) => Partial<SessionEntry> | null,
    ) => {
      patchEnv = scope.env;
      return { ...entry, ...update(entry) };
    },
  );
  const migration = migrateManagedWorktreeCanonicalWorkspaces({
    mode: "doctor-fix",
    agentId: "main",
    cfg: {},
    env,
    storePath: databasePath,
  });
  const joined = migration.then(
    () => undefined,
    () => undefined,
  );
  try {
    await Promise.race([
      entered.promise,
      migration.then(() => {
        throw new Error("Migration completed before the project read");
      }),
    ]);
    env.OpenClaw_State_Dir = path.resolve("/changed-project-state");
    projectRead.resolve(project);
    await expect(migration).resolves.toEqual({ found: 1, repaired: 1 });
    expect(captured?.environment.OPENCLAW_STATE_DIR).toBe(root);
    expect(captured?.admission.databasePath).toBe(path.join(root, "state", "openclaw.sqlite"));
    expect(mocks.listWorktrees.mock.calls[0]?.[0].OPENCLAW_STATE_DIR).toBe(root);
    expect(patchEnv?.OPENCLAW_STATE_DIR).toBe(root);
    expect(patchEnv).not.toBe(env);
    expect(Object.keys(patchEnv ?? {})).toContain("OpenClaw_State_Dir");
    expect(Object.keys(patchEnv ?? {})).not.toContain("OPENCLAW_STATE_DIR");
    expect(env.OpenClaw_State_Dir).toBe(path.resolve("/changed-project-state"));
    expect(Object.hasOwn(env, "OPENCLAW_STATE_DIR")).toBe(false);
    expect(mocks.forbiddenSqlite).not.toHaveBeenCalled();
  } finally {
    projectRead.resolve(project);
    await joined;
    platform.mockRestore();
  }
});
