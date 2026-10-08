// Agent mutation tests cover create/update/delete handlers, safe workspace file
// access, config preconditions, trash cleanup, and workspace-state handling.

import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { AgentDeletionAuthorityRollbackError } from "../../agents/agent-lifecycle-registry.js";
import { WORKSPACE_BOOTSTRAP_FILENAMES } from "../../agents/workspace.js";
import { FsSafeError, root } from "../../infra/fs-safe.js";
import { registerAgentDeleteFilesystemTests } from "./agents-delete-filesystem.test-support.js";
import { registerAgentIdentityUpdateTests } from "./agents-identity-update.test-support.js";
import {
  cleanupPath,
  createEnoentError,
  createErrnoError,
  deletionJournal,
  expectRecordFields,
  expectRespondErrorContaining,
  expectRespondOk,
  firstRespondResult,
  makeFileStat,
  mockCallArg,
  registerAgentCreationCommitTests,
} from "./agents-mutate.test-support.js";
const mocks = vi.hoisted(() => ({
  sharedAuthStoreOwnership: { location: "legacy-main" } as {
    location: "legacy-main" | "state-db";
  },
  loadConfigReturn: {} as Record<string, unknown>,
  listAgentEntries: vi.fn((_cfg?: unknown) => [] as Array<Record<string, unknown>>),
  findAgentEntryIndex: vi.fn((_list?: unknown, _agentId?: string) => -1),
  applyAgentConfig: vi.fn((_cfg: unknown, _opts: unknown) => ({})),
  pruneAgentConfig: vi.fn(() => ({ config: {}, removedBindings: 0 })),
  writeConfigFile: vi.fn(async (_nextConfig?: unknown, _writeOptions?: unknown) => {}),
  omitConfigMutationResult: false,
  ensureAgentWorkspace: vi.fn(
    async (params?: { dir?: string }): Promise<{ dir: string; identityPathCreated: boolean }> => ({
      dir: params?.dir
        ? params.dir.startsWith("/resolved/")
          ? params.dir
          : `/resolved${params.dir.startsWith("/") ? "" : "/"}${params.dir}`
        : "/resolved/workspace",
      identityPathCreated: false,
    }),
  ),
  isWorkspaceSetupCompleted: vi.fn(async () => false),
  deleteWorkspaceState: vi.fn(),
  prepareWorkspaceStateDeletion: vi.fn((workspaceDir: string) => ({ workspaceDir })),
  withAgentExecApprovalsRemoved: vi.fn(
    async (_agentId: string, commit: () => Promise<unknown>) => await commit(),
  ),
  assertAgentDeletionCurrent: vi.fn(),
  beginAgentDeletionRollback: vi.fn(),
  beginAgentDeletionFinish: vi.fn(),
  closeDeletedAgentDatabases: vi.fn(async () => {}),
  hasDeletedAgentDatabases: vi.fn(() => false),
  reviveAgentDatabases: vi.fn(async (_agentIds: readonly string[]) => {}),
  logGatewayWarn: vi.fn(),
  runAgentDatabaseCleanup: vi.fn(
    async (_target: unknown, run: () => Promise<unknown>) => await run(),
  ),
  claimCompletedAgentDeletion: vi.fn(() => true),
  readAgentDeletionJournal: vi.fn(() => undefined as Record<string, unknown> | undefined),
  resolveOpenClawAgentSqlitePath: vi.fn(
    (params?: { path?: string }) => params?.path ?? "/agents/test-agent/openclaw-agent.sqlite",
  ),
  closeOpenClawAgentDatabaseByPath: vi.fn((_pathname?: string, _expectedAgentId?: string) => true),
  listOpenClawRegisteredAgentDatabases: vi.fn(() => [] as Array<Record<string, unknown>>),
  unregisterOpenClawAgentDatabase: vi.fn(),
  assertNoOpenClawAgentDatabaseLeases: vi.fn(),
  registerResolvedAgentDir: vi.fn(),
  resolveRegisteredAgentIdForDir: vi.fn((_pathname?: string) => undefined as string | undefined),
  isPathOwnedByAnotherRegisteredAgent: vi.fn(
    (_params: { agentId: string; pathname: string }) => false,
  ),
  normalizeAgentDirRegistryPath: vi.fn((pathname: string) => path.resolve(pathname)),
  unregisterResolvedAgentDir: vi.fn((_params: { agentId: string; agentDir: string }) => true),
  cronRemoveAgentJobsTransactional: vi.fn(
    async (_agentId: string, commit: () => Promise<unknown>) => await commit(),
  ),
  resolveAgentDir: vi.fn((_cfg?: unknown, agentId?: string) =>
    agentId === "main" ? "/agents/main/agent" : "/agents/test-agent",
  ),
  resolveAgentWorkspaceDir: vi.fn((_cfg?: unknown, _agentId?: string) => "/workspace/test-agent"),
  resolveSessionTranscriptsDirForAgent: vi.fn((_agentId?: string) => "/transcripts/test-agent"),
  listAgentsForGateway: vi.fn(() => ({
    defaultId: "main",
    mainKey: "agent:main:main",
    scope: "global",
    agents: [],
  })),
  movePathToTrash: vi.fn(async (_pathname?: string) => "/trashed"),
  fsMkdir: vi.fn(async () => undefined),
  fsAppendFile: vi.fn(async () => {}),
  fsReadFile: vi.fn(async () => ""),
  fsStat: vi.fn(async (..._args: unknown[]) => null as import("node:fs").Stats | null),
  fsLstat: vi.fn(async (..._args: unknown[]) => null as import("node:fs").Stats | null),
  fsRealpath: vi.fn(async (p: string) => p),
  fsReadlink: vi.fn(async (_pathname: string) => ""),
  fsRm: vi.fn(async () => undefined),
  fsOpen: vi.fn(async () => ({}) as unknown),
  rootRead: vi.fn(async (_params: { rootDir: string; relativePath: string }) => ({
    buffer: Buffer.from(""),
    realPath: "/workspace/test-agent/AGENTS.md",
    stat: { size: 0, mtimeMs: 0 },
  })),
  rootOpen: vi.fn(async (_params?: unknown) => ({
    handle: { close: vi.fn(async () => {}) },
    realPath: "/workspace/test-agent/AGENTS.md",
    stat: { size: 0, mtimeMs: 0 },
  })),
  rootStat: vi.fn(async (_params: { rootDir: string; relativePath: string }) => ({
    isFile: true,
    isSymbolicLink: false,
    mtimeMs: 0,
    nlink: 1,
    size: 0,
  })),
  rootWrite: vi.fn(async (_params?: unknown) => {}),
  migrateLegacyMainSessionKeys: vi.fn(),
  purgeAgentSessionStoreEntries: vi.fn(async () => false),
}));

vi.mock("../../config/config.js", async () => {
  const actual =
    await vi.importActual<typeof import("../../config/config.js")>("../../config/config.js");
  return {
    ...actual,
    getRuntimeConfig: () => mocks.loadConfigReturn,
    writeConfigFile: mocks.writeConfigFile,
    replaceConfigFile: async (params: { nextConfig: unknown }) =>
      await mocks.writeConfigFile(params.nextConfig),
    readConfigFileSnapshotForWrite: async () => ({
      snapshot: { sourceConfig: mocks.loadConfigReturn },
    }),
    mutateConfigFileWithRetry: async (params: {
      writeOptions?: unknown;
      mutate: (draft: Record<string, unknown>, context: unknown) => unknown;
    }) => {
      const draft = structuredClone(mocks.loadConfigReturn);
      const result = await params.mutate(draft, {
        snapshot: { path: "/tmp/openclaw/config.json" },
        previousHash: "test-hash",
        attempt: 0,
      });
      await mocks.writeConfigFile(draft, params.writeOptions);
      return {
        path: "/tmp/openclaw/config.json",
        previousHash: "test-hash",
        persistedHash: "persisted-hash",
        snapshot: { path: "/tmp/openclaw/config.json" },
        nextConfig: draft,
        result: mocks.omitConfigMutationResult ? undefined : result,
        attempts: 1,
        afterWrite: { mode: "auto" },
        followUp: { action: "none" },
      };
    },
    transformConfigFileWithRetry: async (params: {
      transform: (
        config: Record<string, unknown>,
        context: unknown,
      ) => Promise<{ nextConfig: Record<string, unknown>; result?: unknown }>;
    }) => {
      const transformed = await params.transform(structuredClone(mocks.loadConfigReturn), {
        snapshot: { path: "/tmp/openclaw/config.json" },
        previousHash: "test-hash",
        attempt: 0,
      });
      await mocks.writeConfigFile(transformed.nextConfig);
      mocks.loadConfigReturn = transformed.nextConfig;
      return {
        path: "/tmp/openclaw/config.json",
        previousHash: "test-hash",
        persistedHash: "persisted-hash",
        snapshot: { path: "/tmp/openclaw/config.json" },
        nextConfig: transformed.nextConfig,
        result: transformed.result,
        attempts: 1,
        afterWrite: { mode: "auto" },
        followUp: { action: "none" },
      };
    },
    withConfigMutationExclusive: async (fn: (config: unknown) => Promise<unknown>) =>
      await fn(mocks.loadConfigReturn),
  };
});

vi.mock("../../commands/agents.config.js", () => ({
  applyAgentConfig: mocks.applyAgentConfig,
  findAgentEntryIndex: mocks.findAgentEntryIndex,
  listAgentEntries: mocks.listAgentEntries,
  pruneAgentConfig: mocks.pruneAgentConfig,
}));

vi.mock("../../agents/auth-profiles/path-resolve.js", async () => ({
  ...(await vi.importActual<typeof import("../../agents/auth-profiles/path-resolve.js")>(
    "../../agents/auth-profiles/path-resolve.js",
  )),
  resolveSharedAuthStoreOwnership: () => mocks.sharedAuthStoreOwnership,
  resolveSharedAuthStorePath: () => "/resolved/agents/main/agent/openclaw-agent.sqlite",
}));

vi.mock("../../config/sessions/legacy-main-session-migration.js", () => ({
  migrateLegacyMainSessionKeys: mocks.migrateLegacyMainSessionKeys,
}));

vi.mock("../../config/sessions.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../config/sessions.js")>()),
  purgeAgentSessionStoreEntries: mocks.purgeAgentSessionStoreEntries,
}));

vi.mock("../../agents/agent-scope.js", () => ({
  listAgentIds: () => ["main"],
  listAgentEntries: mocks.listAgentEntries,
  resolveDefaultAgentId: (cfg: unknown) => {
    const entries = getAgentList(cfg);
    if (entries.length !== 1) {
      throw new Error("expected exactly one agent");
    }
    return entries[0]!.id;
  },
  tryResolveSoleAgentId: (cfg: unknown) => {
    const entries = getAgentList(cfg);
    return entries.length === 1 ? entries[0]?.id : undefined;
  },
  resolveAgentDir: mocks.resolveAgentDir,
  resolveAgentConfig: (cfg: unknown, agentId: string) =>
    getAgentList(cfg).find((entry) => entry.id === agentId),
  resolveAgentWorkspaceDir: mocks.resolveAgentWorkspaceDir,
}));

vi.mock("../../agents/agent-dir-registry.js", () => ({
  isPathOwnedByAnotherRegisteredAgent: mocks.isPathOwnedByAnotherRegisteredAgent,
  normalizeAgentDirRegistryPath: mocks.normalizeAgentDirRegistryPath,
  registerResolvedAgentDir: mocks.registerResolvedAgentDir,
  resolveRegisteredAgentIdForDir: mocks.resolveRegisteredAgentIdForDir,
  unregisterResolvedAgentDir: mocks.unregisterResolvedAgentDir,
}));

vi.mock("../../agents/agent-lifecycle-registry.js", () => ({
  AgentDeletionAuthorityRollbackError: class extends AggregateError {},
  AgentDeletionCommitUncertainError: class extends Error {
    constructor(cause: unknown) {
      super(cause instanceof Error ? cause.message : String(cause));
    }
  },
  withAgentDeletion: async (
    _agentId: string,
    run: (begin: (entry: Record<string, unknown>) => unknown) => Promise<unknown>,
  ) =>
    run((entry) => ({
      entry: Object.assign(entry, {
        databasePaths: entry.databasePaths ?? [],
        cleanupPaths: entry.cleanupPaths ?? [],
      }),
      assertCurrent: mocks.assertAgentDeletionCurrent,
      assertCurrentAsync: async () => {
        await mocks.assertAgentDeletionCurrent();
      },
      fenceDatabasePaths: (paths: string[]) => {
        entry.databasePaths = [...new Set(paths)];
      },
      fenceCleanupPaths: (paths: unknown[]) => {
        entry.cleanupPaths = [...paths];
      },
      finish: mocks.beginAgentDeletionFinish,
      rollback: mocks.beginAgentDeletionRollback,
      runDatabaseCleanup: mocks.runAgentDatabaseCleanup,
    })),
  claimCompletedAgentDeletion: mocks.claimCompletedAgentDeletion,
  isAgentDeletionBlocked: () => false,
}));

vi.mock("../../state/openclaw-agent-db-readers.js", () => ({
  closeDeletedAgentDatabases: mocks.closeDeletedAgentDatabases,
  reviveAgentDatabases: mocks.reviveAgentDatabases,
}));

vi.mock("../../infra/agent-database-readers.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/agent-database-readers.js")>()),
  hasDeletedAgentDatabases: mocks.hasDeletedAgentDatabases,
}));

vi.mock("../../infra/exec-approvals.js", () => ({
  withAgentExecApprovalsRemoved: mocks.withAgentExecApprovalsRemoved,
}));

vi.mock("../../state/openclaw-agent-db.js", () => ({
  closeOpenClawAgentDatabaseByPath: mocks.closeOpenClawAgentDatabaseByPath,
  closeOpenClawAgentDatabaseByPathAsync: async (pathname?: string, expectedAgentId?: string) =>
    mocks.closeOpenClawAgentDatabaseByPath(pathname, expectedAgentId),
  listOpenClawRegisteredAgentDatabases: mocks.listOpenClawRegisteredAgentDatabases,
  resolveOpenClawAgentSqlitePath: mocks.resolveOpenClawAgentSqlitePath,
  resolveIncognitoOpenClawAgentSqlitePath: () =>
    "/agents/test-agent/incognito-openclaw-agent.sqlite",
}));

vi.mock("../../state/agent-deletion-journal.js", () => ({
  readAgentDeletionJournal: mocks.readAgentDeletionJournal,
}));

vi.mock("../../state/openclaw-agent-db-registry.js", () => ({
  unregisterOpenClawAgentDatabase: mocks.unregisterOpenClawAgentDatabase,
}));

vi.mock("../../state/openclaw-agent-db.paths.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../state/openclaw-agent-db.paths.js")>()),
  isSameOpenClawAgentDatabasePath: (left: string, right: string) =>
    path.resolve(left) === path.resolve(right),
}));

vi.mock("../../state/openclaw-agent-db-lease.js", () => ({
  assertNoOpenClawAgentDatabaseLeases: mocks.assertNoOpenClawAgentDatabaseLeases,
}));

vi.mock("../../agents/workspace.js", async () => {
  const actual = await vi.importActual<typeof import("../../agents/workspace.js")>(
    "../../agents/workspace.js",
  );
  return {
    ...actual,
    ensureAgentWorkspace: mocks.ensureAgentWorkspace,
    isWorkspaceSetupCompleted: mocks.isWorkspaceSetupCompleted,
  };
});

vi.mock("../../agents/workspace-state-store.js", async () => ({
  ...(await vi.importActual<typeof import("../../agents/workspace-state-store.js")>(
    "../../agents/workspace-state-store.js",
  )),
  deleteWorkspaceState: mocks.deleteWorkspaceState,
  prepareWorkspaceStateDeletion: mocks.prepareWorkspaceStateDeletion,
}));

vi.mock("../../config/sessions/paths.js", () => ({
  resolveSessionTranscriptsDirForAgent: mocks.resolveSessionTranscriptsDirForAgent,
}));

vi.mock("../../plugin-sdk/browser-maintenance.js", () => ({
  movePathToTrash: mocks.movePathToTrash,
}));

function expectTrashedWithinParent(pathname: string, declaredPath = pathname): void {
  expect(mocks.movePathToTrash).toHaveBeenCalledWith(
    pathname,
    expect.objectContaining({
      allowedRoots: expect.arrayContaining([path.dirname(declaredPath)]),
    }),
  );
}

function expectNotTrashed(pathname: string): void {
  expect(mocks.movePathToTrash.mock.calls.map(([target]) => target)).not.toContain(pathname);
}

vi.mock("../../utils.js", async () => {
  const actual = await vi.importActual<typeof import("../../utils.js")>("../../utils.js");
  return {
    ...actual,
    resolveUserPath: (p: string) => `/resolved${p.startsWith("/") ? "" : "/"}${p}`,
  };
});

vi.mock("../session-utils.js", () => ({
  listAgentsForGateway: mocks.listAgentsForGateway,
}));

vi.mock("../../infra/fs-safe.js", async () => {
  const actual =
    await vi.importActual<typeof import("../../infra/fs-safe.js")>("../../infra/fs-safe.js");
  return {
    ...actual,
    root: vi.fn(async (rootDir: string) => ({
      rootReal: rootDir,
      open: async (relativePath: string, options?: Record<string, unknown>) =>
        await mocks.rootOpen({ rootDir, relativePath, ...options }),
      stat: async (relativePath: string) => await mocks.rootStat({ rootDir, relativePath }),
      read: async (relativePath: string, options?: Record<string, unknown>) =>
        await mocks.rootRead({ rootDir, relativePath, ...options }),
      write: async (
        relativePath: string,
        data: string | Buffer,
        options?: Record<string, unknown>,
      ) =>
        await mocks.rootWrite({
          rootDir,
          relativePath,
          data,
          ...options,
        }),
    })),
  };
});

// Mock node:fs/promises – agents.ts uses `import fs from "node:fs/promises"`
// which resolves to the module namespace default, so we spread actual and
// override the methods we need, plus set `default` explicitly.
vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  const patched = {
    ...actual,
    mkdir: mocks.fsMkdir,
    appendFile: mocks.fsAppendFile,
    readFile: mocks.fsReadFile,
    stat: mocks.fsStat,
    lstat: mocks.fsLstat,
    realpath: mocks.fsRealpath,
    readlink: mocks.fsReadlink,
    rm: mocks.fsRm,
    open: mocks.fsOpen,
  };
  return { ...patched, default: patched };
});

const { agentsHandlers } = await import("./agents.js");

beforeEach(() => {
  vi.mocked(root).mockReset();
  mocks.omitConfigMutationResult = false;
  mocks.sharedAuthStoreOwnership = { location: "legacy-main" };
  mocks.migrateLegacyMainSessionKeys.mockReset().mockResolvedValue({
    armed: true,
    changes: [],
    complete: true,
    ledgerComplete: true,
    legacyAgentId: "main",
    mainKey: "main",
    outcomes: [{ kind: "no-legacy-rows", detail: "matching completed ledger" }],
    ownerAgentId: "robby",
    warnings: [],
  });
  mocks.withAgentExecApprovalsRemoved
    .mockReset()
    .mockImplementation(async (_agentId: string, commit: () => Promise<unknown>) => await commit());
  mocks.assertAgentDeletionCurrent.mockReset();
  mocks.beginAgentDeletionRollback.mockReset();
  mocks.beginAgentDeletionFinish.mockReset();
  mocks.readAgentDeletionJournal.mockReset().mockReturnValue(undefined);
  mocks.resolveOpenClawAgentSqlitePath
    .mockReset()
    .mockImplementation(
      (params?: { path?: string }) => params?.path ?? "/agents/test-agent/openclaw-agent.sqlite",
    );
  mocks.closeOpenClawAgentDatabaseByPath.mockReset().mockReturnValue(true);
  mocks.listOpenClawRegisteredAgentDatabases.mockReset().mockReturnValue([]);
  mocks.unregisterOpenClawAgentDatabase.mockReset();
  mocks.registerResolvedAgentDir.mockReset();
  mocks.resolveRegisteredAgentIdForDir
    .mockReset()
    .mockImplementation((pathname?: string) =>
      pathname === "/agents/test-agent" || pathname === "/journal/agent" ? "test-agent" : undefined,
    );
  mocks.isPathOwnedByAnotherRegisteredAgent.mockReset().mockReturnValue(false);
  mocks.normalizeAgentDirRegistryPath.mockReset().mockImplementation((pathname) => pathname);
  mocks.unregisterResolvedAgentDir.mockReset().mockReturnValue(true);
  mocks.cronRemoveAgentJobsTransactional
    .mockReset()
    .mockImplementation(async (_agentId: string, commit: () => Promise<unknown>) => await commit());
  mocks.loadConfigReturn = {};
  mocks.listAgentEntries.mockImplementation((cfg: unknown) => getAgentList(cfg));
  mocks.findAgentEntryIndex.mockImplementation((list: unknown, agentId?: string) =>
    (Array.isArray(list) ? (list as MockAgentEntry[]) : []).findIndex(
      (entry) => entry.id === agentId,
    ),
  );
  mocks.applyAgentConfig.mockImplementation((cfg: unknown, opts: unknown) =>
    mergeAgentConfig(cfg, opts),
  );
  mocks.resolveAgentWorkspaceDir.mockImplementation((cfg: unknown, agentId?: string) =>
    resolveMockWorkspaceDir(cfg, agentId),
  );
  mocks.rootOpen.mockResolvedValue({
    handle: { close: vi.fn(async () => {}) },
    realPath: "/workspace/test-agent/AGENTS.md",
    stat: { size: 0, mtimeMs: 0 },
  });
  mocks.rootRead.mockResolvedValue({
    buffer: Buffer.from(""),
    realPath: "/workspace/test-agent/AGENTS.md",
    stat: { size: 0, mtimeMs: 0 },
  });
  mocks.rootStat.mockImplementation(async ({ rootDir, relativePath }) => {
    const stat = await mocks.fsLstat(path.join(rootDir, relativePath));
    return {
      dev: stat?.dev,
      ino: stat?.ino,
      isFile: stat?.isFile?.() ?? true,
      isSymbolicLink: stat?.isSymbolicLink?.() ?? false,
      mtimeMs: stat?.mtimeMs ?? 0,
      nlink: stat?.nlink ?? 1,
      size: stat?.size ?? 0,
    };
  });
  mocks.rootWrite.mockResolvedValue(undefined);
});

function makeCall(method: keyof typeof agentsHandlers, params: Record<string, unknown>) {
  const respond = vi.fn();
  const handler = expectDefined(agentsHandlers[method], "agentsHandlers[method] test invariant");
  const promise = handler({
    params,
    respond,
    context: {
      getRuntimeConfig: () => mocks.loadConfigReturn,
      cron: { removeAgentJobsTransactional: mocks.cronRemoveAgentJobsTransactional },
      logGateway: { warn: mocks.logGatewayWarn },
    } as never,
    req: { type: "req" as const, id: "1", method },
    client: null,
    isWebchatConnect: () => false,
  });
  return { respond, promise };
}

async function call(method: keyof typeof agentsHandlers, params: Record<string, unknown>) {
  const { respond, promise } = makeCall(method, params);
  await promise;
  return respond;
}

type MockIdentity = {
  name?: string;
  theme?: string;
  emoji?: string;
  avatar?: string;
};

type MockAgentEntry = {
  id: string;
  name?: string;
  workspace?: string;
  agentDir?: string;
  model?: string;
  identity?: MockIdentity;
};

type MockConfig = {
  agents?: {
    entries?: Record<string, Omit<MockAgentEntry, "id">>;
  };
};

function getAgentList(cfg: unknown): MockAgentEntry[] {
  return Object.entries((cfg as MockConfig | undefined)?.agents?.entries ?? {}).map(([id, entry]) =>
    Object.assign({}, entry, { id }),
  );
}

function mergeAgentConfig(cfg: unknown, opts: unknown): MockConfig {
  const config = (cfg as MockConfig | undefined) ?? {};
  const params = (opts as {
    agentId?: string;
    name?: string;
    workspace?: string;
    agentDir?: string;
    model?: string | null;
    identity?: MockIdentity;
  }) ?? { agentId: "" };
  const list = getAgentList(config);
  const agentId = params.agentId ?? "";
  const index = list.findIndex((entry) => entry.id === agentId);
  const base = index >= 0 ? expectDefined(list[index], "existing agent entry") : { id: agentId };
  const nextEntry: MockAgentEntry = {
    ...base,
    ...(params.name ? { name: params.name } : {}),
    ...(params.workspace ? { workspace: params.workspace } : {}),
    ...(params.agentDir ? { agentDir: params.agentDir } : {}),
    ...(params.model ? { model: params.model } : {}),
    ...(params.identity ? { identity: { ...base.identity, ...params.identity } } : {}),
  };
  if (params.model === null) {
    delete nextEntry.model;
  }
  if (index >= 0) {
    list[index] = nextEntry;
  } else {
    list.push(nextEntry);
  }
  return {
    ...config,
    agents: {
      ...config.agents,
      entries: Object.fromEntries(list.map(({ id, ...entry }) => [id, entry])),
    },
  };
}

function resolveMockWorkspaceDir(cfg: unknown, agentId?: string): string {
  const resolvedAgentId = agentId ?? "";
  return (
    getAgentList(cfg).find((entry) => entry.id === resolvedAgentId)?.workspace ??
    `/workspace/${resolvedAgentId}`
  );
}

async function listAgentFileNames(agentId = "main") {
  const respond = await call("agents.files.list", { agentId });

  const result = firstRespondResult(respond);
  const files = (result as { files: Array<{ name: string }> }).files;
  return files.map((file) => file.name);
}

function expectNotFoundResponseAndNoWrite(respond: ReturnType<typeof vi.fn>) {
  expectRespondErrorContaining(respond, "not found");
  expect(mocks.writeConfigFile).not.toHaveBeenCalled();
}

async function expectUnsafeWorkspaceFile(method: "agents.files.get" | "agents.files.set") {
  const params =
    method === "agents.files.set"
      ? { agentId: "main", name: "AGENTS.md", content: "x" }
      : { agentId: "main", name: "AGENTS.md" };
  const respond = await call(method, params);
  expectRespondErrorContaining(respond, "unsafe workspace file");
}

beforeEach(() => {
  mocks.fsReadFile.mockImplementation(async () => {
    throw createEnoentError();
  });
  mocks.fsStat.mockImplementation(async () => {
    throw createEnoentError();
  });
  mocks.fsLstat.mockImplementation(async () => {
    throw createEnoentError();
  });
  mocks.fsRealpath.mockImplementation(async (p: string) => p);
  mocks.fsReadlink.mockReset().mockResolvedValue("");
  mocks.fsOpen.mockImplementation(
    async () =>
      ({
        stat: async () => makeFileStat(),
        readFile: async () => Buffer.from(""),
        truncate: async () => {},
        writeFile: async () => {},
        close: async () => {},
      }) as unknown,
  );
});

describe("agents.create", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.hasDeletedAgentDatabases.mockReturnValue(false);
    mocks.reviveAgentDatabases.mockReset().mockResolvedValue(undefined);
    mocks.loadConfigReturn = {
      agents: { entries: { main: {} } },
    };
  });

  registerAgentCreationCommitTests({
    ...mocks,
    create: (params) => makeCall("agents.create", params),
    configuredConfig: () => mocks.loadConfigReturn,
  });

  it("rejects invalid params (missing name)", async () => {
    const respond = await call("agents.create", {
      workspace: "/tmp/ws",
    });

    expectRespondErrorContaining(respond, "invalid");
  });

  it("writes emoji and avatar to both config and IDENTITY.md", async () => {
    const respond = await call("agents.create", {
      name: "Fancy Agent",
      model: "sonnet-4.6",
      workspace: "/tmp/ws",
      emoji: "🤖",
      avatar: "https://example.com/avatar.png",
    });

    expectRespondOk(respond, {
      ok: true,
      agentId: "fancy-agent",
      name: "Fancy Agent",
      model: "sonnet-4.6",
    });
    const configOptions = expectRecordFields(mockCallArg(mocks.applyAgentConfig, 0, 1), {
      model: "sonnet-4.6",
    });
    expectRecordFields(configOptions.identity, {
      name: "Fancy Agent",
      emoji: "🤖",
      avatar: "https://example.com/avatar.png",
    });
    const write = expectRecordFields(mockCallArg(mocks.rootWrite), {
      rootDir: "/resolved/tmp/ws",
      relativePath: "IDENTITY.md",
    });
    expect(write.data).toBe(
      [
        "# IDENTITY.md - Agent Identity",
        "",
        "- Name: Fancy Agent",
        "- Emoji: 🤖",
        "- Avatar: https://example.com/avatar.png",
        "",
      ].join("\n"),
    );
  });
});

describe("agents.update", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.loadConfigReturn = {
      agents: {
        entries: {
          "test-agent": {
            workspace: "/workspace/test-agent",
            identity: {
              name: "Current Agent",
              theme: "steady",
              emoji: "🐢",
            },
          },
        },
      },
    };
  });

  it("rejects updating a nonexistent agent", async () => {
    mocks.findAgentEntryIndex.mockReturnValue(-1);

    const respond = await call("agents.update", {
      agentId: "nonexistent",
    });

    expectNotFoundResponseAndNoWrite(respond);
  });

  it("returns not found when a concurrent delete wins the update race", async () => {
    let findCallCount = 0;
    mocks.findAgentEntryIndex.mockImplementation(() => {
      findCallCount += 1;
      return findCallCount >= 2 ? -1 : 0;
    });

    const respond = await call("agents.update", {
      agentId: "test-agent",
      model: "gpt-5.5",
    });

    expectNotFoundResponseAndNoWrite(respond);
  });

  it("clears an existing model override", async () => {
    mocks.loadConfigReturn = {
      agents: {
        defaults: { model: { primary: "openai/gpt-5.6-luna" } },
        entries: {
          "test-agent": {
            workspace: "/workspace/test-agent",
            model: "anthropic/claude-sonnet-4-6",
          },
        },
      },
    };

    const respond = await call("agents.update", {
      agentId: "test-agent",
      model: null,
    });

    expectRespondOk(respond, { ok: true, agentId: "test-agent" });
    expectRecordFields(mockCallArg(mocks.applyAgentConfig, 0, 1), { model: null });
    const persisted = expectRecordFields(mockCallArg(mocks.writeConfigFile), {});
    const agents = expectRecordFields(persisted.agents, {});
    const entries = expectRecordFields(agents.entries, {});
    const agent = expectRecordFields(entries["test-agent"], {});
    expect(agent).not.toHaveProperty("model");
  });

  registerAgentIdentityUpdateTests({
    mocks,
    makeCall,
    makeFileStat,
    createEnoentError,
  });
});

describe("agents.delete", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveAgentDir.mockImplementation((_cfg?: unknown, agentId?: string) =>
      agentId === "main" ? "/agents/main/agent" : "/agents/test-agent",
    );
    mocks.fsLstat.mockResolvedValue({
      isSymbolicLink: () => false,
    } as unknown as import("node:fs").Stats);
    mocks.fsRealpath.mockImplementation(async (pathname: string) => pathname);
    mocks.loadConfigReturn = {
      agents: {
        entries: {
          "test-agent": { workspace: "/workspace/test-agent" },
          main: {},
        },
      },
    };
    mocks.findAgentEntryIndex.mockReturnValue(0);
    mocks.pruneAgentConfig.mockReturnValue({
      config: { agents: { entries: { main: {} } } },
      removedBindings: 2,
    });
    mocks.movePathToTrash.mockReset().mockResolvedValue("/trashed");
    mocks.purgeAgentSessionStoreEntries.mockReset().mockResolvedValue(false);
  });

  it("rejects deleting the auth-inheritance owner before starting cleanup", async () => {
    mocks.sharedAuthStoreOwnership = { location: "state-db" };
    mocks.loadConfigReturn = {
      agents: {
        defaults: { authInheritance: { agentId: "test-agent" } },
        entries: {
          "test-agent": { workspace: "/workspace/test-agent" },
          main: {},
        },
      },
    };
    const respond = await call("agents.delete", { agentId: "test-agent" });

    expectRespondErrorContaining(respond, "agents.defaults.authInheritance.agentId");
    expect(mocks.cronRemoveAgentJobsTransactional).not.toHaveBeenCalled();
    expect(mocks.writeConfigFile).not.toHaveBeenCalled();
    expect(mocks.movePathToTrash).not.toHaveBeenCalled();
  });

  it("removes only the deleted agent's authority before committing its roster removal", async () => {
    const cronJobs = [
      { id: "deleted-job", agentId: "test-agent" },
      { id: "other-job", agentId: "other-agent" },
    ];
    const approvals = new Set(["test-agent", "other-agent"]);
    const events: string[] = [];
    mocks.cronRemoveAgentJobsTransactional.mockImplementation(
      async (agentId: string, commit: () => Promise<unknown>) => {
        const snapshot = structuredClone(cronJobs);
        cronJobs.splice(0, cronJobs.length, ...cronJobs.filter((job) => job.agentId !== agentId));
        events.push("cron");
        try {
          return await commit();
        } catch (error) {
          cronJobs.splice(0, cronJobs.length, ...snapshot);
          throw error;
        }
      },
    );
    mocks.withAgentExecApprovalsRemoved.mockImplementation(
      async (agentId: string, commit: () => Promise<unknown>) => {
        const existed = approvals.delete(agentId);
        events.push("approvals");
        try {
          return await commit();
        } catch (error) {
          if (existed) {
            approvals.add(agentId);
          }
          throw error;
        }
      },
    );
    mocks.writeConfigFile.mockImplementationOnce(async () => {
      events.push("config");
    });
    mocks.unregisterResolvedAgentDir.mockImplementationOnce(() => {
      events.push("directory");
      return true;
    });
    mocks.closeOpenClawAgentDatabaseByPath.mockImplementation(() => {
      events.push("database");
      return true;
    });

    const respond = await call("agents.delete", { agentId: "test-agent" });

    const result = expectRespondOk(respond, {
      ok: true,
      agentId: "test-agent",
      removedBindings: 2,
      failed: [],
    });
    expect(result).not.toHaveProperty("purgeFailed");
    expect(result.removed).toEqual(
      expect.arrayContaining([
        { path: "/workspace/test-agent", method: "trash" },
        { path: "/agents/test-agent", method: "trash" },
        { path: "/transcripts/test-agent", method: "trash" },
      ]),
    );
    expect(mocks.writeConfigFile).toHaveBeenCalledWith(expect.anything(), {
      allowConfigSizeDrop: true,
      assertConfigPathForWrite: mocks.assertAgentDeletionCurrent,
      allowedAgentRosterRemovals: ["test-agent"],
    });
    expect(mocks.deleteWorkspaceState).toHaveBeenCalledWith(
      { workspaceDir: "/workspace/test-agent" },
      { assertCurrent: mocks.assertAgentDeletionCurrent },
    );
    expect(cronJobs).toEqual([{ id: "other-job", agentId: "other-agent" }]);
    expect(approvals).toEqual(new Set(["other-agent"]));
    expect(mocks.cronRemoveAgentJobsTransactional).toHaveBeenCalledWith(
      "test-agent",
      expect.any(Function),
    );
    expect(mocks.withAgentExecApprovalsRemoved).toHaveBeenCalledWith(
      "test-agent",
      expect.any(Function),
    );
    expect(mocks.closeOpenClawAgentDatabaseByPath).toHaveBeenCalledWith(
      "/agents/test-agent/openclaw-agent.sqlite",
      "test-agent",
    );
    expect(mocks.unregisterOpenClawAgentDatabase).toHaveBeenCalledWith({
      agentId: "test-agent",
      path: "/agents/test-agent/openclaw-agent.sqlite",
    });
    expect(mocks.unregisterResolvedAgentDir).toHaveBeenCalledWith({
      agentId: "test-agent",
      agentDir: "/agents/test-agent",
    });
    expect(events).toEqual(["database", "database", "cron", "approvals", "config", "directory"]);
    expect(mocks.beginAgentDeletionFinish).toHaveBeenCalledOnce();
  });

  it("rolls cron back and keeps the roster when authority cleanup fails", async () => {
    const cronJobs = [
      { id: "deleted-job", agentId: "test-agent" },
      { id: "other-job", agentId: "other-agent" },
    ];
    mocks.cronRemoveAgentJobsTransactional.mockImplementation(
      async (agentId: string, commit: () => Promise<unknown>) => {
        const snapshot = structuredClone(cronJobs);
        cronJobs.splice(0, cronJobs.length, ...cronJobs.filter((job) => job.agentId !== agentId));
        try {
          return await commit();
        } catch (error) {
          cronJobs.splice(0, cronJobs.length, ...snapshot);
          throw error;
        }
      },
    );
    mocks.withAgentExecApprovalsRemoved.mockRejectedValueOnce(new Error("approvals busy"));

    const { promise } = makeCall("agents.delete", { agentId: "test-agent" });

    await expect(promise).rejects.toThrow("approvals busy");
    expect(cronJobs).toEqual([
      { id: "deleted-job", agentId: "test-agent" },
      { id: "other-job", agentId: "other-agent" },
    ]);
    expect(mocks.beginAgentDeletionRollback).toHaveBeenCalledOnce();
    expect(mocks.writeConfigFile).not.toHaveBeenCalled();
    expect(mocks.closeOpenClawAgentDatabaseByPath).toHaveBeenCalledTimes(2);
    expect(mocks.movePathToTrash).not.toHaveBeenCalled();
  });

  it("keeps a recovered deletion journal fenced when retry cleanup fails", async () => {
    mocks.readAgentDeletionJournal.mockReturnValue(deletionJournal());
    mocks.withAgentExecApprovalsRemoved.mockRejectedValueOnce(new Error("approvals busy"));

    const { promise } = makeCall("agents.delete", { agentId: "test-agent" });

    await expect(promise).rejects.toThrow("approvals busy");
    expect(mocks.beginAgentDeletionRollback).not.toHaveBeenCalled();
    expect(mocks.beginAgentDeletionFinish).not.toHaveBeenCalled();
    expect(mocks.writeConfigFile).not.toHaveBeenCalled();
  });

  it("keeps a new deletion fenced when authority rollback fails", async () => {
    mocks.withAgentExecApprovalsRemoved.mockRejectedValueOnce(
      new AgentDeletionAuthorityRollbackError(
        [new Error("config failed"), new Error("approval restore failed")],
        "approval rollback failed",
      ),
    );

    const { promise } = makeCall("agents.delete", { agentId: "test-agent" });

    await expect(promise).rejects.toThrow("approval rollback failed");
    expect(mocks.beginAgentDeletionRollback).not.toHaveBeenCalled();
    expect(mocks.writeConfigFile).not.toHaveBeenCalled();
  });

  it("keeps deletion fenced when config persistence succeeds before reporting failure", async () => {
    let configuredCheck = 0;
    mocks.findAgentEntryIndex.mockImplementation(() => {
      configuredCheck += 1;
      return configuredCheck < 4 ? 0 : -1;
    });
    mocks.writeConfigFile.mockImplementationOnce(async (nextConfig?: unknown) => {
      if (!nextConfig || typeof nextConfig !== "object") {
        throw new Error("expected config object");
      }
      mocks.loadConfigReturn = nextConfig as Record<string, unknown>;
      throw new Error("post-write refresh failed");
    });

    const { promise } = makeCall("agents.delete", { agentId: "test-agent" });

    await expect(promise).rejects.toThrow("post-write refresh failed");
    expect(mocks.beginAgentDeletionRollback).not.toHaveBeenCalled();
    expect(mocks.closeOpenClawAgentDatabaseByPath).toHaveBeenCalled();
    expect(mocks.movePathToTrash).not.toHaveBeenCalled();
  });

  it("does not perform destructive cleanup without a config deletion result", async () => {
    mocks.omitConfigMutationResult = true;

    const { promise } = makeCall("agents.delete", { agentId: "test-agent" });

    await expect(promise).rejects.toThrow("config mutation did not return its target");
    expect(mocks.closeOpenClawAgentDatabaseByPath).toHaveBeenCalledTimes(2);
    expect(mocks.movePathToTrash).not.toHaveBeenCalled();
    expect(mocks.unregisterOpenClawAgentDatabase).not.toHaveBeenCalled();
    expect(mocks.beginAgentDeletionRollback).toHaveBeenCalledOnce();
  });

  it("keeps authority removed when the committed config omits its mutation result", async () => {
    mocks.omitConfigMutationResult = true;
    let configuredCheck = 0;
    mocks.findAgentEntryIndex.mockImplementation(() => {
      configuredCheck += 1;
      return configuredCheck < 4 ? 0 : -1;
    });

    const { promise } = makeCall("agents.delete", { agentId: "test-agent" });

    await expect(promise).rejects.toThrow("config mutation did not return its target");
    expect(mocks.beginAgentDeletionRollback).not.toHaveBeenCalled();
    expect(mocks.movePathToTrash).not.toHaveBeenCalled();
    expect(mocks.unregisterOpenClawAgentDatabase).not.toHaveBeenCalled();
  });

  it("converges after partial cleanup and makes the agent id recreatable", async () => {
    const journal = deletionJournal({
      agentDir: "/agents/test-agent",
      workspaceDir: "/workspace/test-agent",
      sessionsDir: "/transcripts/test-agent",
    });
    const trashed = new Set<string>();
    let workspaceAttempts = 0;
    mocks.fsLstat.mockImplementation(async (pathname: unknown) => {
      if (trashed.has(String(pathname))) {
        throw createEnoentError();
      }
      return null as unknown as import("node:fs").Stats;
    });
    mocks.movePathToTrash.mockImplementation(async (pathname?: string) => {
      if (pathname === journal.workspaceDir && workspaceAttempts++ === 0) {
        throw new Error("workspace trash failed");
      }
      trashed.add(pathname ?? "");
      return "/trashed";
    });
    mocks.beginAgentDeletionFinish.mockImplementation(() => {
      journal.cleanupCompleted = true;
    });
    mocks.readAgentDeletionJournal.mockReturnValue(journal);

    const firstDelete = makeCall("agents.delete", { agentId: "test-agent" });
    await firstDelete.promise;

    expectRespondOk(firstDelete.respond, {
      failed: [{ path: journal.workspaceDir, reason: "workspace trash failed" }],
    });
    expect(mocks.purgeAgentSessionStoreEntries.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.closeDeletedAgentDatabases.mock.invocationCallOrder[0]!,
    );
    expect(mocks.closeDeletedAgentDatabases.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.movePathToTrash.mock.invocationCallOrder[0]!,
    );
    expect(mocks.beginAgentDeletionFinish).not.toHaveBeenCalled();
    expect(mocks.unregisterOpenClawAgentDatabase).not.toHaveBeenCalled();
    expect(mocks.unregisterResolvedAgentDir).toHaveBeenCalledWith({
      agentId: "test-agent",
      agentDir: journal.agentDir,
    });
    const completedAgentDir = journal.cleanupPaths.find((entry) => entry.path === journal.agentDir);
    expect(completedAgentDir?.done).toBe(true);
    const agentDirMoveCount = mocks.movePathToTrash.mock.calls.filter(
      ([pathname]) => pathname === journal.agentDir,
    ).length;
    trashed.delete(journal.agentDir);
    mocks.findAgentEntryIndex.mockReturnValue(-1);
    mocks.readAgentDeletionJournal.mockReturnValue(journal);
    const blockedCreate = makeCall("agents.create", { name: "Test Agent" });
    await blockedCreate.promise;
    expectRespondErrorContaining(blockedCreate.respond, "still pending");

    mocks.closeDeletedAgentDatabases.mockRejectedValueOnce(new Error("native reader close failed"));
    const trashAttempts = mocks.movePathToTrash.mock.calls.length;
    const failedClose = makeCall("agents.delete", { agentId: "test-agent" });
    await expect(failedClose.promise).rejects.toThrow("native reader close failed");
    expect(mocks.movePathToTrash).toHaveBeenCalledTimes(trashAttempts);
    expect(mocks.beginAgentDeletionFinish).not.toHaveBeenCalled();
    expect(journal.cleanupCompleted).toBe(false);

    const recovery = makeCall("agents.delete", { agentId: "test-agent" });
    await recovery.promise;

    expectRespondOk(recovery.respond, { failed: [] });
    expect(
      mocks.movePathToTrash.mock.calls.filter(([pathname]) => pathname === journal.agentDir),
    ).toHaveLength(agentDirMoveCount);
    expect(trashed.has(journal.agentDir)).toBe(false);
    expect(mocks.beginAgentDeletionFinish).toHaveBeenCalledOnce();
    expect(journal.cleanupCompleted).toBe(true);
    const recreated = makeCall("agents.create", { name: "Test Agent" });
    await recreated.promise;
    expectRespondOk(recreated.respond, { ok: true, agentId: "test-agent" });
  });

  it("sweeps leaked files that appeared at prepared-absent journal paths", async () => {
    const workspaceDir = "/journal/workspace";
    const workspaceAlias = "/journal/workspace-alias";
    const journal = deletionJournal({
      workspaceDir,
      databasePaths: [workspaceAlias],
      cleanupPaths: [
        cleanupPath("/journal/agent", {
          dev: 1,
          ino: 10,
          done: true,
        }),
        cleanupPath(workspaceDir, {
          parentPath: "/journal",
        }),
        cleanupPath("/journal/sessions", {
          dev: 1,
          ino: 30,
          done: true,
        }),
      ],
    });
    mocks.findAgentEntryIndex.mockReturnValue(-1);
    mocks.readAgentDeletionJournal.mockReturnValue(journal);
    mocks.fsRealpath.mockImplementation(async (pathname: string) =>
      pathname === workspaceAlias ? workspaceDir : pathname,
    );
    mocks.fsLstat.mockImplementation(
      async (pathname: unknown) =>
        ({
          dev: 2,
          ino: pathname === workspaceDir ? 200 : 100,
          isFile: () => false,
          isSymbolicLink: () => false,
          nlink: 1,
        }) as unknown as import("node:fs").Stats,
    );

    const respond = await call("agents.delete", { agentId: "test-agent" });

    expectRespondOk(respond, { failed: [] });
    // The journal fence blocked legitimate claims while this path was prepared
    // absent, so the appeared occupant is leaked deleted-agent state: sweep it
    // instead of preserving it and finishing over a surviving tree.
    expectTrashedWithinParent(workspaceDir);
    const appearedRecord = journal.cleanupPaths.find((entry) => entry.path === workspaceDir);
    expect(appearedRecord).toMatchObject({ done: true });
    expect(appearedRecord).not.toHaveProperty("note");
    expect(mocks.beginAgentDeletionFinish).toHaveBeenCalledOnce();
  });

  it("protects a pending ancestor when a done descendant is recreated", async () => {
    const workspaceDir = "/journal/workspace";
    const completedChild = `${workspaceDir}/cleaned`;
    const journal = deletionJournal({
      workspaceDir,
      cleanupPaths: [
        cleanupPath(completedChild, {
          parentPath: workspaceDir,
          sourcePaths: [workspaceDir],
          dev: 1,
          ino: 10,
          done: true,
        }),
        cleanupPath(workspaceDir, {
          parentPath: "/journal",
          dev: 1,
          ino: 20,
        }),
      ],
    });
    mocks.findAgentEntryIndex.mockReturnValue(-1);
    mocks.readAgentDeletionJournal.mockReturnValue(journal);
    mocks.fsLstat.mockImplementation(async (pathname: unknown) => {
      if (pathname !== completedChild && pathname !== workspaceDir) {
        throw createEnoentError();
      }
      return {
        dev: pathname === completedChild ? 2 : 1,
        ino: pathname === completedChild ? 100 : 20,
        isFile: () => false,
        isSymbolicLink: () => false,
        nlink: 1,
      } as unknown as import("node:fs").Stats;
    });

    const respond = await call("agents.delete", { agentId: "test-agent" });

    expectRespondOk(respond, { failed: [] });
    expectNotTrashed(completedChild);
    expectNotTrashed(workspaceDir);
    expect(journal.cleanupPaths.find((entry) => entry.path === workspaceDir)).toMatchObject({
      done: true,
      note: "completed cleanup path is occupied; replacement preserved",
    });
    expect(mocks.beginAgentDeletionFinish).toHaveBeenCalledOnce();
  });

  it("treats a source that disappears during Trash as successful cleanup", async () => {
    let workspaceLstatCalls = 0;
    mocks.fsLstat.mockImplementation(async (pathname: unknown) => {
      if (pathname === "/workspace/test-agent" && workspaceLstatCalls++ > 1) {
        throw createEnoentError();
      }
      return null as unknown as import("node:fs").Stats;
    });
    mocks.movePathToTrash.mockImplementation(async (pathname?: string) => {
      if (pathname === "/workspace/test-agent") {
        throw createEnoentError();
      }
      return "/trashed";
    });

    const respond = await call("agents.delete", { agentId: "test-agent" });

    const result = expectRespondOk(respond, { failed: [] });
    expect(result.removed).toEqual(
      expect.arrayContaining([{ path: "/workspace/test-agent", method: "missing" }]),
    );
    expect(mocks.beginAgentDeletionFinish).toHaveBeenCalledOnce();
  });

  it("does not move a symlink ancestor when its canonical descendant fails", async () => {
    const agentLink = "/deep/journal/link";
    const agentTarget = "/target";
    mocks.findAgentEntryIndex.mockReturnValue(-1);
    mocks.readAgentDeletionJournal.mockReturnValue(
      deletionJournal({
        agentDir: agentLink,
        workspaceDir: "/deep",
        sessionsDir: "/deep/sessions",
      }),
    );
    mocks.resolveRegisteredAgentIdForDir.mockImplementation((pathname?: string) =>
      pathname === agentLink ? "test-agent" : undefined,
    );
    mocks.normalizeAgentDirRegistryPath.mockImplementation((pathname: string) =>
      pathname.replace(agentLink, agentTarget),
    );
    mocks.fsRealpath.mockImplementation(async (pathname: string) =>
      pathname.replace(agentLink, agentTarget),
    );
    mocks.fsLstat.mockImplementation(
      async (pathname: unknown) =>
        ({
          isSymbolicLink: () => pathname === agentLink,
        }) as unknown as import("node:fs").Stats,
    );
    mocks.movePathToTrash.mockImplementation(async (pathname?: string) => {
      if (pathname === agentTarget) {
        throw new Error("agent trash failed");
      }
      return "/trashed";
    });

    const respond = await call("agents.delete", { agentId: "test-agent" });

    expectRespondOk(respond, {
      failed: [{ path: agentTarget, reason: "agent trash failed" }],
    });
    expectNotTrashed(agentLink);
    expectNotTrashed("/deep");
    expectTrashedWithinParent(agentTarget, agentLink);
    expect(mocks.unregisterResolvedAgentDir).not.toHaveBeenCalled();
    expect(mocks.beginAgentDeletionFinish).not.toHaveBeenCalled();
  });

  it("does not trash a replacement at a journaled symlink path", async () => {
    const workspaceLink = "/journal/workspace-link";
    mocks.findAgentEntryIndex.mockReturnValue(-1);
    const journal = deletionJournal({
      workspaceDir: workspaceLink,
      cleanupPaths: [
        cleanupPath("/canonical/workspace", {
          sourcePaths: [workspaceLink],
        }),
        cleanupPath(workspaceLink, {
          parentPath: "/journal",
          kind: "symlink",
          coversDescendants: false,
        }),
        cleanupPath("/journal/agent"),
        cleanupPath("/journal/sessions"),
      ],
    });
    mocks.readAgentDeletionJournal.mockReturnValue(journal);

    const respond = await call("agents.delete", { agentId: "test-agent" });

    expectRespondOk(respond, { failed: [] });
    expectNotTrashed(workspaceLink);
    const replacementRecord = expectDefined(
      journal.cleanupPaths.find((entry) => entry.path === workspaceLink),
      "replacement cleanup record",
    );
    expect(replacementRecord).toMatchObject({
      done: true,
      note: "cleanup path changed from symlink before deletion",
    });
    expect(mocks.beginAgentDeletionFinish).toHaveBeenCalledOnce();
  });

  it("resolves a symlinked workspace and removes descendants before its target and link", async () => {
    const workspaceParent = "/tmp-root";
    const workspaceParentTarget = "/real-tmp/source-parent";
    const workspaceLink = `${workspaceParent}/workspace-link`;
    const canonicalWorkspaceLink = `${workspaceParentTarget}/workspace-link`;
    const workspaceTarget = "/real-tmp/workspace";
    const agentDir = `${workspaceLink}/agent`;
    const sessionsDir = `${workspaceLink}/transcripts`;
    mocks.findAgentEntryIndex.mockReturnValue(-1);
    mocks.readAgentDeletionJournal.mockReturnValue(
      deletionJournal({
        agentDir,
        workspaceDir: workspaceLink,
        sessionsDir,
      }),
    );
    mocks.resolveRegisteredAgentIdForDir.mockImplementation((pathname?: string) =>
      pathname === agentDir ? "test-agent" : undefined,
    );
    mocks.normalizeAgentDirRegistryPath.mockImplementation((pathname: string) =>
      pathname.replace(workspaceLink, workspaceTarget),
    );
    mocks.fsRealpath.mockImplementation(async (pathname: string) => {
      if (pathname === workspaceParent) {
        return workspaceParentTarget;
      }
      return pathname.replace(workspaceLink, workspaceTarget);
    });
    mocks.fsLstat.mockImplementation(
      async (pathname: unknown) =>
        ({
          isSymbolicLink: () => pathname === workspaceLink || pathname === canonicalWorkspaceLink,
        }) as unknown as import("node:fs").Stats,
    );

    const respond = await call("agents.delete", { agentId: "test-agent" });

    expectRespondOk(respond, { failed: [] });
    const trashedPaths = mocks.movePathToTrash.mock.calls.map(([pathname]) => String(pathname));
    const targetIndex = trashedPaths.indexOf(workspaceTarget);
    expectTrashedWithinParent(`${workspaceTarget}/agent`, agentDir);
    expectTrashedWithinParent(`${workspaceTarget}/transcripts`, sessionsDir);
    expect(trashedPaths.indexOf(`${workspaceTarget}/agent`)).toBeLessThan(targetIndex);
    expect(trashedPaths.indexOf(`${workspaceTarget}/transcripts`)).toBeLessThan(targetIndex);
    expect(targetIndex).toBeLessThan(trashedPaths.indexOf(canonicalWorkspaceLink));
    expectTrashedWithinParent(workspaceTarget, workspaceLink);
    expectTrashedWithinParent(canonicalWorkspaceLink, workspaceLink);
    expectNotTrashed(workspaceLink);
    expect(mocks.unregisterResolvedAgentDir).toHaveBeenCalledWith({
      agentId: "test-agent",
      agentDir: `${workspaceTarget}/agent`,
    });
    expect(mocks.beginAgentDeletionFinish).toHaveBeenCalledOnce();
  });

  it("does not commit deletion when a journaled path cannot be resolved", async () => {
    const resolutionError = Object.assign(new Error("workspace target is inaccessible"), {
      code: "EACCES",
    });
    mocks.fsRealpath.mockImplementation(async (pathname: string) => {
      if (pathname === "/workspace/test-agent") {
        throw resolutionError;
      }
      return pathname;
    });

    const { respond, promise } = makeCall("agents.delete", { agentId: "test-agent" });
    await expect(promise).rejects.toBe(resolutionError);

    expect(respond).not.toHaveBeenCalled();
    expect(mocks.writeConfigFile).not.toHaveBeenCalled();
    expect(mocks.movePathToTrash).not.toHaveBeenCalled();
    expect(mocks.beginAgentDeletionRollback).toHaveBeenCalledOnce();
    expect(mocks.beginAgentDeletionFinish).not.toHaveBeenCalled();
  });

  it("recovers against the persisted target when a workspace symlink is retargeted", async () => {
    const workspaceLink = "/tmp-root/workspace-link";
    const originalTarget = "/real-tmp/original-workspace";
    const retargetedWorkspace = "/real-tmp/replacement-workspace";
    const missingTranscriptTarget = `${originalTarget}/transcripts`;
    const journal = deletionJournal({
      agentDir: `${workspaceLink}/agent`,
      workspaceDir: workspaceLink,
      sessionsDir: `${workspaceLink}/transcripts`,
    });
    const trashed = new Set<string>();
    let workspaceAttempts = 0;
    mocks.findAgentEntryIndex.mockReturnValue(-1);
    mocks.readAgentDeletionJournal.mockReturnValue(journal);
    mocks.resolveRegisteredAgentIdForDir.mockImplementation((pathname?: string) =>
      pathname === journal.agentDir ? "test-agent" : undefined,
    );
    mocks.normalizeAgentDirRegistryPath.mockImplementation((pathname: string) =>
      pathname.replace(workspaceLink, originalTarget),
    );
    mocks.fsRealpath.mockImplementation(async (pathname: string) => {
      if (pathname === journal.sessionsDir) {
        throw createEnoentError();
      }
      return pathname.replace(workspaceLink, originalTarget);
    });
    mocks.fsLstat.mockImplementation(async (pathname: unknown) => {
      if (
        pathname === journal.sessionsDir ||
        pathname === missingTranscriptTarget ||
        trashed.has(String(pathname))
      ) {
        throw createEnoentError();
      }
      return {
        isSymbolicLink: () => pathname === workspaceLink,
      } as unknown as import("node:fs").Stats;
    });
    mocks.movePathToTrash.mockImplementation(async (pathname?: string) => {
      if (pathname === originalTarget && workspaceAttempts++ === 0) {
        throw new Error("workspace trash failed");
      }
      trashed.add(pathname ?? "");
      return "/trashed";
    });

    const firstDelete = makeCall("agents.delete", { agentId: "test-agent" });
    await firstDelete.promise;

    expectRespondOk(firstDelete.respond, {
      failed: [{ path: originalTarget, reason: "workspace trash failed" }],
    });
    expect(mocks.beginAgentDeletionFinish).not.toHaveBeenCalled();
    expect(journal).toHaveProperty("cleanupPaths");

    mocks.fsRealpath.mockClear();
    mocks.fsRealpath.mockImplementation(async (pathname: string) =>
      pathname.replace(workspaceLink, retargetedWorkspace),
    );
    const recovery = makeCall("agents.delete", { agentId: "test-agent" });
    await recovery.promise;

    expectRespondOk(recovery.respond, { failed: [] });
    expect(mocks.fsRealpath).not.toHaveBeenCalled();
    expectNotTrashed(missingTranscriptTarget);
    expectNotTrashed(retargetedWorkspace);
    expectNotTrashed(`${retargetedWorkspace}/transcripts`);
    expectTrashedWithinParent(originalTarget, workspaceLink);
    expectTrashedWithinParent(workspaceLink);
    expect(mocks.beginAgentDeletionFinish).toHaveBeenCalledOnce();
  });

  it("does not follow a retargeted canonical ancestor during recovery", async () => {
    const canonicalRoot = "/canonical/deleted";
    const unrelatedRoot = "/unrelated/current";
    const workspaceDir = "/linked/workspace";
    const journal = deletionJournal({
      agentDir: `${workspaceDir}/agent`,
      workspaceDir,
      sessionsDir: `${workspaceDir}/transcripts`,
      cleanupPaths: [
        cleanupPath(`${canonicalRoot}/workspace/agent`, {
          parentPath: `${canonicalRoot}/workspace`,
          sourcePaths: [`${workspaceDir}/agent`],
        }),
        cleanupPath(`${canonicalRoot}/workspace/transcripts`, {
          parentPath: `${canonicalRoot}/workspace`,
          sourcePaths: [`${workspaceDir}/transcripts`],
        }),
        cleanupPath(`${canonicalRoot}/workspace`, {
          parentPath: canonicalRoot,
          sourcePaths: [workspaceDir],
        }),
      ],
    });
    mocks.findAgentEntryIndex.mockReturnValue(-1);
    mocks.readAgentDeletionJournal.mockReturnValue(journal);
    mocks.resolveRegisteredAgentIdForDir.mockImplementation((pathname?: string) =>
      pathname === journal.agentDir ? "test-agent" : undefined,
    );
    const defaultRoot = expectDefined(vi.mocked(root).getMockImplementation(), "root mock");
    vi.mocked(root).mockImplementation(async (...args) => ({
      ...(await defaultRoot(...args)),
      rootReal: args[0].startsWith(canonicalRoot)
        ? args[0].replace(canonicalRoot, unrelatedRoot)
        : args[0],
    }));

    const respond = await call("agents.delete", { agentId: "test-agent" });

    const result = expectRespondOk(respond, {});
    expect(result.failed).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ reason: "cleanup path parent changed before deletion" }),
      ]),
    );
    expect(
      mocks.movePathToTrash.mock.calls.some(([pathname]) =>
        String(pathname).startsWith(unrelatedRoot),
      ),
    ).toBe(false);
    expect(mocks.beginAgentDeletionFinish).not.toHaveBeenCalled();
  });

  it("reclaims durable journal ownership after a process restart", async () => {
    const directoryOwners = new Map<string, string>();
    mocks.findAgentEntryIndex.mockReturnValue(-1);
    mocks.readAgentDeletionJournal.mockReturnValue(deletionJournal());
    mocks.resolveRegisteredAgentIdForDir.mockImplementation((pathname?: string) =>
      directoryOwners.get(pathname ?? ""),
    );
    mocks.registerResolvedAgentDir.mockImplementation(
      ({ agentId, agentDir }: { agentId: string; agentDir: string }) => {
        directoryOwners.set(agentDir, agentId);
      },
    );
    mocks.unregisterResolvedAgentDir.mockImplementation(
      ({ agentId, agentDir }: { agentId: string; agentDir: string }) => {
        if (directoryOwners.get(agentDir) !== agentId) {
          return false;
        }
        return directoryOwners.delete(agentDir);
      },
    );

    const respond = await call("agents.delete", { agentId: "test-agent" });

    expectRespondOk(respond, { ok: true });
    expect(mocks.registerResolvedAgentDir).toHaveBeenCalledWith({
      agentId: "test-agent",
      agentDir: "/journal/agent",
    });
    expect(mocks.closeOpenClawAgentDatabaseByPath).toHaveBeenCalledWith(
      "/journal/agent/openclaw-agent.sqlite",
      "test-agent",
    );
    expectTrashedWithinParent("/journal/agent");
    expect(directoryOwners.has("/journal/agent")).toBe(false);
    expect(mocks.beginAgentDeletionFinish).toHaveBeenCalledOnce();
  });

  it("settles recovery without touching a journaled directory claimed by another agent", async () => {
    const directoryOwners = new Map([["/journal/agent", "other-agent"]]);
    const databaseRows = [
      { agentId: "test-agent", path: "/journal/agent/openclaw-agent.sqlite" },
      { agentId: "other-agent", path: "/journal/agent/openclaw-agent.sqlite" },
    ];
    mocks.findAgentEntryIndex.mockReturnValue(-1);
    mocks.readAgentDeletionJournal.mockReturnValue(
      deletionJournal({ workspaceDir: "/journal", sessionsDir: "/deleted/sessions" }),
    );
    mocks.resolveRegisteredAgentIdForDir.mockImplementation((pathname?: string) =>
      directoryOwners.get(pathname ?? ""),
    );
    mocks.isPathOwnedByAnotherRegisteredAgent.mockImplementation(
      ({ agentId, pathname }: { agentId: string; pathname: string }) =>
        (pathname === "/journal/agent" || pathname.startsWith("/journal/agent/")) &&
        directoryOwners.get("/journal/agent") !== agentId,
    );
    mocks.unregisterResolvedAgentDir.mockImplementation(
      ({ agentId, agentDir }: { agentId: string; agentDir: string }) => {
        if (directoryOwners.get(agentDir) !== agentId) {
          return false;
        }
        return directoryOwners.delete(agentDir);
      },
    );
    mocks.listOpenClawRegisteredAgentDatabases.mockImplementation(() => databaseRows);
    mocks.unregisterOpenClawAgentDatabase.mockImplementation(
      ({ agentId, path: databasePath }: { agentId: string; path: string }) => {
        const index = databaseRows.findIndex(
          (entry) => entry.agentId === agentId && entry.path === databasePath,
        );
        if (index >= 0) {
          databaseRows.splice(index, 1);
        }
      },
    );

    const respond = await call("agents.delete", { agentId: "test-agent" });

    expectRespondOk(respond, { ok: true });
    expect(mocks.listOpenClawRegisteredAgentDatabases).toHaveBeenCalled();
    expect(mocks.closeOpenClawAgentDatabaseByPath).toHaveBeenCalledWith(
      "/journal/agent/openclaw-agent.sqlite",
      "test-agent",
    );
    expect(mocks.assertNoOpenClawAgentDatabaseLeases).toHaveBeenCalledWith("test-agent", {});
    expect(mocks.closeDeletedAgentDatabases).toHaveBeenCalledWith("test-agent", []);
    expectNotTrashed("/journal/agent");
    expectNotTrashed("/journal");
    expectTrashedWithinParent("/deleted/sessions");
    expect(mocks.unregisterOpenClawAgentDatabase).toHaveBeenCalledWith({
      agentId: "test-agent",
      path: "/journal/agent/openclaw-agent.sqlite",
    });
    expect(databaseRows).toEqual([
      { agentId: "other-agent", path: "/journal/agent/openclaw-agent.sqlite" },
    ]);
    expect(mocks.unregisterResolvedAgentDir).toHaveBeenCalledWith({
      agentId: "test-agent",
      agentDir: "/journal/agent",
    });
    expect(directoryOwners.get("/journal/agent")).toBe("other-agent");
    expect(mocks.beginAgentDeletionFinish).toHaveBeenCalledOnce();
  });

  it("revalidates database ownership after earlier filesystem cleanup", async () => {
    let claimed = false;
    mocks.findAgentEntryIndex.mockReturnValue(-1);
    mocks.readAgentDeletionJournal.mockReturnValue(deletionJournal());
    mocks.listOpenClawRegisteredAgentDatabases.mockImplementation(() =>
      claimed ? [{ agentId: "other-agent", path: "/journal/agent/survivor.sqlite" }] : [],
    );
    mocks.movePathToTrash.mockImplementation(async (pathname?: string) => {
      if (pathname === "/journal/agent/openclaw-agent.sqlite") {
        claimed = true;
      }
      return "/trashed";
    });

    const respond = await call("agents.delete", { agentId: "test-agent" });

    expectRespondOk(respond, { ok: true });
    expectTrashedWithinParent("/journal/agent/openclaw-agent.sqlite");
    expectTrashedWithinParent("/journal/workspace");
    expectNotTrashed("/journal/agent");
    expectNotTrashed("/journal/agent/survivor.sqlite");
    expect(mocks.beginAgentDeletionFinish).toHaveBeenCalledOnce();
  });

  it("protects every journaled path claimed as a surviving agent workspace", async () => {
    mocks.loadConfigReturn = {
      agents: { entries: { "other-agent": { workspace: "/journal" } } },
    };
    mocks.findAgentEntryIndex.mockReturnValue(-1);
    mocks.readAgentDeletionJournal.mockReturnValue(deletionJournal());

    const respond = await call("agents.delete", { agentId: "test-agent" });

    expectRespondOk(respond, { ok: true, removed: [], failed: [] });
    expect(mocks.closeOpenClawAgentDatabaseByPath).toHaveBeenCalledWith(
      "/journal/agent/openclaw-agent.sqlite",
      "test-agent",
    );
    expect(mocks.movePathToTrash).not.toHaveBeenCalled();
    expect(mocks.deleteWorkspaceState).not.toHaveBeenCalled();
    expect(mocks.beginAgentDeletionFinish).toHaveBeenCalledOnce();
  });

  it("preserves a relocated database path registered to another agent", async () => {
    const databaseRows = [
      { agentId: "test-agent", path: "/linked/shared/agent.sqlite" },
      { agentId: "other-agent", path: "/real/shared/agent.sqlite-wal" },
    ];
    mocks.normalizeAgentDirRegistryPath.mockImplementation((pathname: string) =>
      pathname.startsWith("/linked/shared/")
        ? pathname.replace("/linked/shared/", "/real/shared/")
        : path.resolve(pathname),
    );
    mocks.listOpenClawRegisteredAgentDatabases.mockImplementation(() => databaseRows);
    mocks.unregisterOpenClawAgentDatabase.mockImplementation(
      ({ agentId, path: databasePath }: { agentId: string; path: string }) => {
        const index = databaseRows.findIndex(
          (entry) => entry.agentId === agentId && entry.path === databasePath,
        );
        if (index >= 0) {
          databaseRows.splice(index, 1);
        }
      },
    );

    const respond = await call("agents.delete", { agentId: "test-agent" });

    expectRespondOk(respond, { ok: true });
    expect(mocks.closeOpenClawAgentDatabaseByPath).toHaveBeenCalledTimes(3);
    expect(mocks.closeOpenClawAgentDatabaseByPath).toHaveBeenCalledWith(
      "/agents/test-agent/openclaw-agent.sqlite",
      "test-agent",
    );
    expect(mocks.closeOpenClawAgentDatabaseByPath).toHaveBeenCalledWith(
      "/linked/shared/agent.sqlite",
      "test-agent",
    );
    expectNotTrashed("/linked/shared/agent.sqlite");
    expectNotTrashed("/linked/shared/agent.sqlite-wal");
    expect(mocks.closeDeletedAgentDatabases).toHaveBeenCalledWith("test-agent", [
      "/agents/test-agent/openclaw-agent.sqlite",
    ]);
    expect(databaseRows).toEqual([
      { agentId: "other-agent", path: "/real/shared/agent.sqlite-wal" },
    ]);
    expect(mocks.beginAgentDeletionFinish).toHaveBeenCalledOnce();
  });

  it("preserves the original keep-files intent while recovering deletion", async () => {
    mocks.findAgentEntryIndex.mockReturnValue(-1);
    mocks.readAgentDeletionJournal.mockReturnValue(
      deletionJournal({
        deleteFiles: false,
      }),
    );

    const respond = await call("agents.delete", { agentId: "test-agent" });

    expectRespondOk(respond, { ok: true, removed: [], failed: [] });
    expect(mocks.movePathToTrash).not.toHaveBeenCalled();
    expect(mocks.unregisterOpenClawAgentDatabase).not.toHaveBeenCalled();
    expect(mocks.beginAgentDeletionFinish).toHaveBeenCalledOnce();
  });

  it("uses the new request intent when deleting a recreated roster entry", async () => {
    mocks.readAgentDeletionJournal.mockReturnValue(
      deletionJournal({
        operationId: "old-delete",
        agentDir: "/old/agent",
        workspaceDir: "/old/workspace",
        sessionsDir: "/old/sessions",
        cleanupCompleted: true,
      }),
    );

    const respond = await call("agents.delete", {
      agentId: "test-agent",
      deleteFiles: false,
    });

    expectRespondOk(respond, { ok: true, removed: [], failed: [] });
    expect(mocks.claimCompletedAgentDeletion).toHaveBeenCalledWith("test-agent", "old-delete");
    expect(mocks.movePathToTrash).not.toHaveBeenCalled();
    expect(mocks.fsLstat).not.toHaveBeenCalled();
    expect(mocks.deleteWorkspaceState).not.toHaveBeenCalled();
    expect(mocks.unregisterOpenClawAgentDatabase).not.toHaveBeenCalled();
  });

  it("reports failed session cleanup and retains its journal and files for retry", async () => {
    mocks.purgeAgentSessionStoreEntries.mockResolvedValueOnce(true);
    const respond = await call("agents.delete", { agentId: "test-agent" });

    expectRespondOk(respond, { ok: true, purgeFailed: true });
    expect(mocks.purgeAgentSessionStoreEntries).toHaveBeenCalledWith(
      expect.anything(),
      "test-agent",
      { runDatabaseCleanup: mocks.runAgentDatabaseCleanup },
    );
    expect(mocks.movePathToTrash).not.toHaveBeenCalled();
    expect(mocks.beginAgentDeletionFinish).not.toHaveBeenCalled();
  });

  it("sweeps WAL sidecars recreated between deletion preparation and cleanup", async () => {
    const agentDir = "/agents/test-agent";
    const walPath = `${agentDir}/openclaw-agent.sqlite-wal`;
    const shmPath = `${agentDir}/openclaw-agent.sqlite-shm`;
    const presentStats = new Map<string, { dev: number; ino: number; file: boolean }>([
      [agentDir, { dev: 1, ino: 10, file: false }],
      ["/workspace/test-agent", { dev: 1, ino: 20, file: false }],
      ["/transcripts/test-agent", { dev: 1, ino: 30, file: false }],
    ]);
    mocks.fsLstat.mockImplementation(async (pathname: unknown) => {
      const stat = presentStats.get(String(pathname));
      if (!stat) {
        throw createEnoentError();
      }
      return {
        dev: stat.dev,
        ino: stat.ino,
        isFile: () => stat.file,
        isSymbolicLink: () => false,
        nlink: 1,
      } as unknown as import("node:fs").Stats;
    });
    // The live runtime reopens the agent database while deletion awaits config,
    // cron, and session-purge work, recreating -wal/-shm after preparation.
    mocks.cronRemoveAgentJobsTransactional.mockImplementation(
      async (_agentId: string, commit: () => Promise<unknown>) => {
        presentStats.set(walPath, { dev: 1, ino: 40, file: true });
        presentStats.set(shmPath, { dev: 1, ino: 41, file: true });
        return await commit();
      },
    );

    const respond = await call("agents.delete", { agentId: "test-agent" });

    expectRespondOk(respond, { failed: [] });
    const trashedPaths = mocks.movePathToTrash.mock.calls.map(([pathname]) => pathname);
    expect(trashedPaths).toContain(walPath);
    expect(trashedPaths).toContain(shmPath);
    expect(trashedPaths).toContain(agentDir);
    expect(mocks.beginAgentDeletionFinish).toHaveBeenCalledOnce();
  });

  it.each(["session purge", "workspace cleanup"] as const)(
    "keeps remaining resources when deletion retires during %s",
    async (boundary) => {
      const retired = new Error("deletion owner retired");
      const retire = async () => {
        await Promise.resolve();
        mocks.assertAgentDeletionCurrent.mockImplementation(() => {
          throw retired;
        });
        return false;
      };
      if (boundary === "session purge") {
        mocks.purgeAgentSessionStoreEntries.mockImplementationOnce(retire);
      } else {
        mocks.deleteWorkspaceState.mockImplementationOnce(retire);
      }

      const { respond, promise } = makeCall("agents.delete", { agentId: "test-agent" });
      await expect(promise).rejects.toBe(retired);
      expect(respond).not.toHaveBeenCalled();
      if (boundary === "session purge") {
        expect(mocks.closeDeletedAgentDatabases).not.toHaveBeenCalled();
        expect(mocks.movePathToTrash).not.toHaveBeenCalled();
      }
      expect(mocks.unregisterOpenClawAgentDatabase).not.toHaveBeenCalled();
      expect(mocks.unregisterResolvedAgentDir).not.toHaveBeenCalled();
      expect(mocks.beginAgentDeletionFinish).not.toHaveBeenCalled();
    },
  );

  registerAgentDeleteFilesystemTests({
    mocks,
    makeCall,
    makeFileStat,
    expectNotTrashed,
    expectTrashedWithinParent,
  });

  it("rejects deleting the main agent", async () => {
    mocks.loadConfigReturn = {
      agents: { entries: { main: {}, ops: {} } },
    };
    const respond = await call("agents.delete", {
      agentId: "main",
    });

    expectRespondErrorContaining(respond, "owns the legacy shared auth store");
    expectRespondErrorContaining(respond, "openclaw doctor --fix");
    expect(mocks.writeConfigFile).not.toHaveBeenCalled();
  });

  it("rejects an unrepresentable id before targeting the main agent", async () => {
    mocks.sharedAuthStoreOwnership = { location: "state-db" };
    mocks.loadConfigReturn = {
      agents: { entries: { main: {}, ops: {} } },
    };

    const respond = await call("agents.delete", {
      agentId: "агент✨",
    });

    expectRespondErrorContaining(respond, 'agent "агент✨" not found');
    expect(mocks.writeConfigFile).not.toHaveBeenCalled();
    expect(mocks.movePathToTrash).not.toHaveBeenCalled();
  });

  it("returns not found when a concurrent delete wins the delete race", async () => {
    let findCallCount = 0;
    mocks.findAgentEntryIndex.mockImplementation(() => {
      findCallCount += 1;
      return findCallCount >= 2 ? -1 : 0;
    });

    const respond = await call("agents.delete", {
      agentId: "test-agent",
    });

    expectNotFoundResponseAndNoWrite(respond);
    expect(mocks.movePathToTrash).not.toHaveBeenCalled();
  });

  it("rejects invalid params (missing agentId)", async () => {
    const respond = await call("agents.delete", {});

    expectRespondErrorContaining(respond, "invalid");
  });
});

describe("agents.files.list", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.loadConfigReturn = {};
    mocks.isWorkspaceSetupCompleted.mockReset().mockResolvedValue(false);
    mocks.fsReadlink.mockReset().mockResolvedValue("");
  });

  // Pins the derivation: a private copy of this list in the gateway is what let a
  // retired file linger in the Control UI as a permanently-missing tab.
  it("lists the canonical filenames without BOOTSTRAP.md once setup completed", async () => {
    mocks.isWorkspaceSetupCompleted.mockResolvedValue(true);
    const names = await listAgentFileNames();
    expect(names).toStrictEqual(
      WORKSPACE_BOOTSTRAP_FILENAMES.filter(
        (name) => name !== "IDENTITY.md" && name !== "BOOTSTRAP.md",
      ),
    );
  });

  // The identity form owns this file via agents.update; raw writes stay available
  // so removing the editor tab does not remove the capability.
  it("still accepts direct IDENTITY.md writes even though it is not listed", async () => {
    const respond = await call("agents.files.set", {
      agentId: "main",
      name: "IDENTITY.md",
      content: "- Name: Ada\n",
    });

    expectRespondOk(respond, { ok: true });
  });

  it("rejects writes to retired HEARTBEAT.md workspace files", async () => {
    const respond = await call("agents.files.set", {
      agentId: "main",
      name: "HEARTBEAT.md",
      content: "legacy checklist",
    });

    expectRecordFields(expectRespondErrorContaining(respond, "unsupported file"), {
      code: "INVALID_REQUEST",
      message: 'unsupported file "HEARTBEAT.md"',
    });
    expect(mocks.fsMkdir).not.toHaveBeenCalled();
    expect(mocks.rootWrite).not.toHaveBeenCalled();
  });

  // Clients merge the get response over the listed entry, so dropping the flag here
  // made a picked optional file re-render as a fault in the Control UI.
  it("carries expectedAbsent through agents.files.get for a missing file", async () => {
    mocks.rootRead.mockRejectedValue(new FsSafeError("not-found", "no such file"));

    const respond = await call("agents.files.get", {
      agentId: "main",
      name: "SOUL.md",
    });

    const result = firstRespondResult(respond);
    expectRecordFields((result as { file: unknown }).file, {
      name: "SOUL.md",
      missing: true,
      expectedAbsent: true,
    });
  });

  it("reports unreadable workspace files as present in list responses", async () => {
    mocks.isWorkspaceSetupCompleted.mockRejectedValueOnce(createErrnoError("EACCES"));
    mocks.rootOpen.mockRejectedValue(createErrnoError("EACCES"));
    mocks.rootStat.mockImplementation(async ({ relativePath }) => {
      if (relativePath === "AGENTS.md" || relativePath === "SOUL.md") {
        return {
          isFile: true,
          isSymbolicLink: false,
          mtimeMs: 4567,
          nlink: 1,
          size: 17,
        };
      }
      throw createEnoentError();
    });

    const respond = await call("agents.files.list", { agentId: "main" });

    const result = firstRespondResult(respond);
    const files = (
      result as {
        files: Array<{ name: string; missing: boolean; size?: number; expectedAbsent?: boolean }>;
      }
    ).files;
    const names = files.map((file) => file.name);
    expect(names).toStrictEqual(
      WORKSPACE_BOOTSTRAP_FILENAMES.filter((name) => name !== "IDENTITY.md"),
    );
    expect(names).not.toContain("HEARTBEAT.md");
    expect(names).toContain("BOOTSTRAP.md");
    expect(files.filter((file) => file.expectedAbsent === true).map((file) => file.name)).toEqual([
      "USER.md",
      "MEMORY.md",
    ]);
    const soul = files.find((file) => file.name === "SOUL.md");
    expectRecordFields(soul, { missing: false });
    expect(soul).not.toHaveProperty("expectedAbsent");
    expect(
      files
        .filter((file) => file.name !== "AGENTS.md" && file.name !== "SOUL.md")
        .every((file) => file.missing),
    ).toBe(true);
    const file = files.find((entry) => entry.name === "AGENTS.md");
    expectRecordFields(file, {
      name: "AGENTS.md",
      missing: false,
      size: 17,
    });
    expect(mocks.rootOpen).not.toHaveBeenCalled();
  });

  it("keeps rejected root observations out of file listing metadata", async () => {
    mocks.rootStat.mockRejectedValue(new FsSafeError("path-mismatch", "workspace changed"));
    mocks.fsLstat.mockImplementation(async (filePath: unknown) => {
      if (filePath === "/workspace/main/AGENTS.md") {
        return makeFileStat({ size: 23, mtimeMs: 6789 });
      }
      throw createEnoentError();
    });

    const respond = await call("agents.files.list", { agentId: "main" });

    const result = firstRespondResult(respond);
    const files = (result as { files: Array<{ name: string; missing: boolean; size?: number }> })
      .files;
    const file = files.find((entry) => entry.name === "AGENTS.md");
    expectRecordFields(file, {
      name: "AGENTS.md",
      missing: true,
    });
    expect(file).not.toHaveProperty("size");
  });
});

describe("agents.files.get/set symlink safety", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.loadConfigReturn = {
      agents: {
        entries: { main: { workspace: "/workspace/test-agent" } },
      },
    };
    mocks.fsMkdir.mockResolvedValue(undefined);
  });

  function mockWorkspaceEscapeSymlink() {
    const safeOpenError = new FsSafeError("invalid-path", "path escapes workspace root");
    mocks.rootOpen.mockRejectedValue(safeOpenError);
    mocks.rootRead.mockRejectedValue(safeOpenError);
    mocks.rootWrite.mockRejectedValue(safeOpenError);
  }

  it.each([
    { method: "agents.files.get" as const, expectNoOpen: false },
    { method: "agents.files.set" as const, expectNoOpen: true },
  ])(
    "rejects $method when allowlisted file symlink escapes workspace",
    async ({ method, expectNoOpen }) => {
      mockWorkspaceEscapeSymlink();
      await expectUnsafeWorkspaceFile(method);
      if (expectNoOpen) {
        expect(mocks.fsOpen).not.toHaveBeenCalled();
      }
    },
  );

  it("uses non-blocking safe reads for agents.files.get", async () => {
    mocks.rootRead.mockResolvedValue({
      buffer: Buffer.from("hello"),
      realPath: "/workspace/test-agent/AGENTS.md",
      stat: makeFileStat({ size: 5 }),
    });

    const respond = await call("agents.files.get", {
      agentId: "main",
      name: "AGENTS.md",
    });

    expectRecordFields(mockCallArg(mocks.rootRead), {
      rootDir: "/workspace/test-agent",
      relativePath: "AGENTS.md",
      hardlinks: "reject",
    });
    const payload = expectRespondOk(respond, {});
    expectRecordFields(payload.file, {
      name: "AGENTS.md",
      content: "hello",
    });
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
