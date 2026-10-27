import fs from "node:fs";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { WORKSPACE_BOOTSTRAP_FILENAMES } from "../../agents/workspace.js";
import {
  getRuntimeConfigWriteApplication,
  type RuntimeConfigWriteApplicationStatus,
} from "../../config/runtime-write-application.js";
import { memorySessionActorOwners } from "../../config/sessions/session-actor-memory-owner.js";
import { FsSafeError, root, type ReadResult } from "../../infra/fs-safe.js";
import { resumeAgentDeletions } from "../server-agent-deletion-recovery.js";
import * as lifecycleState from "../session-lifecycle-state.js";
import { registerAgentCreateTests } from "./agents-create.test-support.js";
import { registerAgentDeletionAuthorityTests } from "./agents-delete-authority.test-support.js";
import { registerAgentDeleteFilesystemTests } from "./agents-delete-filesystem.test-support.js";
import {
  registerAgentDeleteDrainRecoveryTests,
  registerAgentDeleteRollbackTests,
} from "./agents-delete-recovery.test-support.js";
import { registerAgentIdentityUpdateTests } from "./agents-identity-update.test-support.js";
import {
  cleanupPath,
  createEnoentError,
  createErrnoError,
  createTrashAssertions,
  deletionJournal,
  expectRecordFields,
  expectRespondErrorContaining,
  expectRespondOk,
  agentConfig,
  expectPendingDeletion,
  getAgentList,
  makeFileStat,
  expectUncalled,
  mergeAgentConfig,
  mockCallArg,
  type MockAgentEntry,
} from "./agents-mutate.test-support.js";
function makeRootMetadata(size = 0) {
  return {
    containment: "best-effort" as const,
    realPath: "/workspace/test-agent/AGENTS.md",
    stat: makeFileStat({ size, mtimeMs: 0 }),
    exactIdentity: { dev: 1n, ino: 1n },
  };
}

function makeRootRead(content = "") {
  return { ...makeRootMetadata(Buffer.byteLength(content)), buffer: Buffer.from(content) };
}

function makeRootOpen() {
  const handle = { close: vi.fn(async () => {}) };
  return {
    ...makeRootMetadata(),
    handle,
    async [Symbol.asyncDispose]() {
      await handle.close();
    },
  };
}

const mocks = vi.hoisted(() => ({
  sharedAuthStoreOwnership: { location: "legacy-main" } as {
    location: "legacy-main" | "state-db";
  },
  loadConfigReturn: {} as Record<string, unknown>,
  listAgentEntries: vi.fn<(cfg?: unknown) => Array<Record<string, unknown>>>(),
  findAgentEntryIndex: vi.fn<(list?: unknown, agentId?: string) => number>(),
  applyAgentConfig: vi.fn<(cfg: unknown, opts: unknown) => object>(),
  pruneAgentConfig: vi.fn((_cfg: ReturnType<typeof mergeAgentConfig>, _agentId: string) => ({
    config: {},
    removedBindings: 0,
  })),
  writeConfigFile: vi.fn(async (_nextConfig?: unknown, _writeOptions?: unknown) => {}),
  configApplicationStatus: vi.fn<() => RuntimeConfigWriteApplicationStatus>(() => "applied"),
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
  assertAgentDeletionCurrentAsync: vi.fn<() => Promise<void>>(),
  assertAgentDeletionCurrentFinal: vi.fn<() => void>(),
  beginAgentDeletionRollback: vi.fn(),
  beginAgentDeletionFinish: vi.fn(),
  beginAgentDeletionRetire: vi.fn(),
  readSessionEntrySummariesInWorker: vi.fn<() => Promise<never[]>>(),
  closeDeletedAgentDatabases: vi.fn(async () => {}),
  captureDeletedAgentDatabaseFences: vi.fn<() => [string, string][]>(() => []),
  reviveAgentDatabases: vi.fn(async (_agentIds: readonly string[]) => {}),
  logGatewayWarn: vi.fn(),
  prepareAgentOnboarding: vi.fn(),
  completeAgentOnboarding: vi.fn(),
  startAgentOnboardingConversation: vi.fn(),
  captureGatewayOperatorRunAuthority: vi.fn(),
  runAgentDatabaseCleanup: vi.fn(
    async (_target: unknown, run: () => Promise<unknown>) => await run(),
  ),
  claimCompletedAgentDeletion: vi.fn(() => true),
  readAgentDeletionJournal: vi.fn<() => Record<string, unknown> | undefined>(),
  listPendingAgentDeletionJournals: vi.fn<() => Record<string, unknown>[]>(),
  resolveOpenClawAgentSqlitePath: vi.fn<(params?: { path?: string }) => string>(),
  closeOpenClawAgentDatabaseByPath:
    vi.fn<(pathname?: string, expectedAgentId?: string) => boolean>(),
  listOpenClawRegisteredAgentDatabases: vi.fn<() => Array<Record<string, unknown>>>(),
  assertNoOpenClawAgentDatabaseLeases: vi.fn(),
  registerResolvedAgentDir: vi.fn(),
  resolveRegisteredAgentIdForDir: vi.fn<(pathname?: string) => string | undefined>(),
  isPathOwnedByAnotherRegisteredAgent:
    vi.fn<(params: { agentId: string; pathname: string }) => boolean>(),
  normalizeAgentDirRegistryPath: vi.fn<(pathname: string) => string>(),
  unregisterResolvedAgentDir: vi.fn<(params: { agentId: string; agentDir: string }) => boolean>(),
  cronRemoveAgentJobsTransactional:
    vi.fn<(agentId: string, commit: () => Promise<unknown>) => Promise<unknown>>(),
  resolveAgentDir: vi.fn((_cfg?: unknown, agentId?: string) =>
    agentId === "main" ? "/agents/main/agent" : "/agents/test-agent",
  ),
  resolveAgentWorkspaceDir: vi.fn<(cfg?: unknown, agentId?: string) => string>(),
  resolveSessionTranscriptsDirForAgent: vi.fn((_agentId?: string) => "/transcripts/test-agent"),
  listAgentsForGateway: vi.fn(() => ({
    defaultId: "main",
    mainKey: "agent:main:main",
    scope: "global",
    agents: [],
  })),
  movePathToTrash: vi.fn<(pathname?: string) => Promise<string>>(),
  fsMkdir: vi.fn(async () => undefined),
  fsAppendFile: vi.fn(async () => {}),
  fsReadFile: vi.fn<() => Promise<string>>(),
  fsStat: vi.fn<(...args: unknown[]) => Promise<fs.Stats | null>>(),
  fsLstat: vi.fn<(...args: unknown[]) => Promise<fs.Stats | fs.BigIntStats | null>>(),
  fsRealpath: vi.fn<(pathname: string) => Promise<string>>(),
  fsReadlink: vi.fn<(pathname: string) => Promise<string>>(),
  fsRm: vi.fn(async () => undefined),
  fsOpen: vi.fn<() => Promise<unknown>>(),
  rootRead: vi.fn<(params: { rootDir: string; relativePath: string }) => Promise<ReadResult>>(),
  rootOpen: vi.fn<(params?: unknown) => Promise<ReturnType<typeof makeRootOpen>>>(),
  rootStat: vi.fn<
    (params: { rootDir: string; relativePath: string }) => Promise<{
      isFile: boolean;
      isSymbolicLink: boolean;
      mtimeMs: number;
      nlink: number;
      size: number;
    }>
  >(),
  rootWrite: vi.fn(async (_params?: unknown) => {}),
  migrateLegacyMainSessionKeys: vi.fn(),
  purgeAgentSessionStoreEntries: vi.fn<
    typeof import("../../config/sessions/cleanup-service.js").purgeAgentSessionStoreEntries
  >(async () => false),
}));

vi.mock("../../config/config.js", async (importOriginal) => {
  const context = () => ({
    snapshot: { path: "/tmp/openclaw/config.json" },
    previousHash: "test-hash",
    attempt: 0,
  });
  function settleApplication(writeOptions?: object) {
    const status = mocks.configApplicationStatus();
    if (writeOptions && status !== "unclaimed") {
      getRuntimeConfigWriteApplication(writeOptions)?.claim()?.settle(status);
    }
  }
  return {
    ...(await importOriginal<typeof import("../../config/config.js")>()),
    getRuntimeConfig: () => mocks.loadConfigReturn,
    writeConfigFile: mocks.writeConfigFile,
    replaceConfigFile: async (params: { nextConfig: unknown }) =>
      await mocks.writeConfigFile(params.nextConfig),
    readConfigFileSnapshotForWrite: async () => ({
      snapshot: { sourceConfig: mocks.loadConfigReturn },
    }),
    mutateConfigFileWithRetry: async (params: {
      writeOptions?: object;
      mutate: (draft: Record<string, unknown>, context: unknown) => unknown;
    }) => {
      const draft = structuredClone(mocks.loadConfigReturn);
      const result = await params.mutate(draft, context());
      await mocks.writeConfigFile(draft, params.writeOptions);
      mocks.loadConfigReturn = draft;
      settleApplication(params.writeOptions);
      return { nextConfig: draft, result: mocks.omitConfigMutationResult ? undefined : result };
    },
    transformConfigFileWithRetry: async (params: {
      writeOptions?: object;
      transform: (
        config: Record<string, unknown>,
        context: unknown,
      ) => Promise<{ nextConfig: Record<string, unknown>; result?: unknown }>;
    }) => {
      const transformed = await params.transform(
        structuredClone(mocks.loadConfigReturn),
        context(),
      );
      await mocks.writeConfigFile(transformed.nextConfig);
      mocks.loadConfigReturn = transformed.nextConfig;
      settleApplication(params.writeOptions);
      return {
        path: "/tmp/openclaw/config.json",
        persistedHash: "persisted-hash",
        nextConfig: transformed.nextConfig,
        result: transformed.result,
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

vi.mock("../operator-run-authority.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../operator-run-authority.js")>()),
  captureGatewayOperatorRunAuthority: mocks.captureGatewayOperatorRunAuthority,
}));

vi.mock("../../agents/auth-profiles/path-resolve.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../agents/auth-profiles/path-resolve.js")>()),
  resolveSharedAuthStoreOwnership: () => mocks.sharedAuthStoreOwnership,
  prepareSharedAuthStoreOwnership: async () => mocks.sharedAuthStoreOwnership,
  resolveSharedAuthStorePath: () => "/resolved/agents/main/agent/openclaw-agent.sqlite",
}));

vi.mock("../../config/sessions/legacy-main-session-migration.js", () => ({
  migrateLegacyMainSessionKeys: mocks.migrateLegacyMainSessionKeys,
}));

vi.mock("../../config/sessions.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../config/sessions.js")>()),
  purgeAgentSessionStoreEntries: mocks.purgeAgentSessionStoreEntries,
}));

vi.mock("../../agents/agent-scope.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../agents/agent-scope.js")>()),
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

// mock-isolation: Handler tests inject deletion authority and settlement without real leases or workers.
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
        operationId: entry.operationId ?? "fixture-deletion-operation",
        databasePaths: entry.databasePaths ?? [],
        cleanupPaths: entry.cleanupPaths ?? [],
      }),
      assertCurrentHost: mocks.assertAgentDeletionCurrent,
      assertCurrentAsync: mocks.assertAgentDeletionCurrentAsync,
      assertCurrentFinal: mocks.assertAgentDeletionCurrentFinal,
      fenceDatabasePaths: (paths: string[]) => {
        entry.databasePaths = [...new Set(paths)];
      },
      fenceCleanupPaths: (paths: unknown[]) => {
        entry.cleanupPaths = [...paths];
      },
      finish: mocks.beginAgentDeletionFinish,
      retire: mocks.beginAgentDeletionRetire,
      rollback: mocks.beginAgentDeletionRollback,
      runDatabaseCleanup: mocks.runAgentDatabaseCleanup,
      runWithWorker: async (operation: (scope: { execute: () => void }) => unknown) =>
        operation({ execute: () => mocks.assertNoOpenClawAgentDatabaseLeases(_agentId, {}) }),
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
  captureDeletedAgentDatabaseFences: mocks.captureDeletedAgentDatabaseFences,
}));

vi.mock("../../infra/exec-approvals.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/exec-approvals.js")>()),
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

// mock-isolation: Handler scenarios consume staged journal outcomes without shared-state storage.
vi.mock("../../state/agent-deletion-journal.js", () => ({
  readAgentDeletionJournalAsync: async () => mocks.readAgentDeletionJournal(),
  listPendingAgentDeletionJournalsAsync: async () => ({
    entries: mocks.listPendingAgentDeletionJournals(),
    manualClawAgentIds: [],
  }),
}));

// mock-isolation: Creation reads must consume the staged journal instead of a real worker database.
vi.mock("../../state/agent-deletion-journal.read.js", () => ({
  readAgentDeletionJournalForCreation: async () => mocks.readAgentDeletionJournal(),
  readAgentDeletionRecoveryHoldsInWorker: async () => [],
  readAgentDeletionJournalStatusInWorker: async () => {
    const journal = mocks.readAgentDeletionJournal();
    return journal ? (journal.cleanupCompleted ? "complete" : "pending") : "absent";
  },
}));

// mock-isolation: Handler fixtures stage storage outcomes without owning an agent database worker.
vi.mock("../../state/openclaw-agent-execution.js", () => ({
  prepareOpenClawAgentDatabaseExecution: async () => {},
}));

vi.mock("../../state/agent-provenance.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../state/agent-provenance.js")>()),
  recordAgentProvenance: vi.fn(async () => {}),
}));

// mock-isolation: Registered-path fixtures own discovery and invalidation without the global SQLite memo.
vi.mock("../../state/openclaw-agent-db-registry-listing.js", () => ({
  invalidateRegisteredAgentDatabasesMemo: () => {},
  prepareOpenClawAgentDatabaseRegistrySnapshotRead: () => ({
    read: async () => ({
      assertCurrent: () => {},
      result: { status: "available", entries: mocks.listOpenClawRegisteredAgentDatabases() },
    }),
  }),
}));

vi.mock("../../state/openclaw-agent-db.paths.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../state/openclaw-agent-db.paths.js")>()),
  isSameOpenClawAgentDatabasePath: (left: string, right: string) =>
    path.resolve(left) === path.resolve(right),
}));

vi.mock("../../state/openclaw-agent-db-lease.js", () => ({
  assertNoOpenClawAgentDatabaseLeases: mocks.assertNoOpenClawAgentDatabaseLeases,
}));

vi.mock("../../agents/workspace.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../agents/workspace.js")>()),
  ensureAgentWorkspace: mocks.ensureAgentWorkspace,
  isWorkspaceSetupCompleted: mocks.isWorkspaceSetupCompleted,
}));

vi.mock("../../agents/workspace-state-store.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../agents/workspace-state-store.js")>()),
  deleteWorkspaceState: mocks.deleteWorkspaceState,
  prepareWorkspaceStateDeletion: mocks.prepareWorkspaceStateDeletion,
}));

// mock-isolation: Session locators stay synthetic alongside the mocked filesystem.
vi.mock("../../config/sessions/paths.js", () => ({
  resolveSessionStorePathCore: () => "/transcripts/test-agent/sessions.json",
  resolveSessionTranscriptsDirForAgent: mocks.resolveSessionTranscriptsDirForAgent,
}));

// mock-isolation: Deletion exercises the real drain with synthetic inventory instead of SQLite workers.
vi.mock("../../config/sessions/session-entry-read-runtime.js", () => ({
  readSessionEntrySummariesInWorker: mocks.readSessionEntrySummariesInWorker,
}));

vi.mock("../../plugin-sdk/browser-maintenance.js", () => ({
  movePathToTrash: mocks.movePathToTrash,
}));

const { expectTrashedWithinParent, expectNotTrashed } = createTrashAssertions(
  mocks.movePathToTrash,
);

vi.mock("../../utils.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../utils.js")>()),
  resolveUserPath: (p: string) => `/resolved${p.startsWith("/") ? "" : "/"}${p}`,
}));

// mock-isolation: Keep deletion lifecycle tests on synthetic config and session metadata without opening databases.
vi.mock("../session-utils.js", async () => ({
  resolveSessionStoreKey: (await import("../session-store-key.js")).resolveSessionStoreKey,
  listAgentsForGateway: mocks.listAgentsForGateway,
}));

vi.mock("../../infra/fs-safe.js", async (importOriginal) => {
  return {
    ...(await importOriginal<typeof import("../../infra/fs-safe.js")>()),
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
      ) => await mocks.rootWrite({ rootDir, relativePath, data, ...options }),
    })),
  };
});

// Cover both namespace and default imports of the filesystem.
vi.mock("node:fs/promises", async (importOriginal) => {
  const patched = {
    ...(await importOriginal<typeof import("node:fs/promises")>()),
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

// mock-isolation: exercise creation ordering without model calls or a second transcript writer.
vi.mock(import("./agents-onboarding.js"), () => ({
  prepareAgentOnboarding: mocks.prepareAgentOnboarding,
  completeAgentOnboarding: mocks.completeAgentOnboarding,
  startAgentOnboardingConversation: mocks.startAgentOnboardingConversation,
}));

const { agentsHandlers } = await import("./agents.js");
let restoreLifecyclePersistence: (() => void) | undefined;

afterEach(() => {
  restoreLifecyclePersistence?.();
  memorySessionActorOwners.reset();
});

beforeEach(() => {
  // The roster fixture owns synthetic storage; cancellation authority stays real.
  const lifecyclePersistence = vi
    .spyOn(lifecycleState, "persistGatewaySessionLifecycleEvent")
    .mockImplementation(async (params) => params.assertCommitAllowed?.());
  restoreLifecyclePersistence = () => lifecyclePersistence.mockRestore();
  vi.mocked(root).mockReset();
  mocks.writeConfigFile.mockReset().mockResolvedValue(undefined);
  mocks.configApplicationStatus.mockReset().mockReturnValue("applied");
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
  mocks.withAgentExecApprovalsRemoved.mockReset();
  mocks.assertAgentDeletionCurrent.mockReset();
  mocks.assertAgentDeletionCurrentAsync.mockReset().mockImplementation(async () => {
    mocks.assertAgentDeletionCurrent();
  });
  mocks.assertAgentDeletionCurrentFinal.mockReset().mockImplementation(() => {
    mocks.assertAgentDeletionCurrent();
  });
  mocks.beginAgentDeletionRollback.mockReset();
  mocks.beginAgentDeletionFinish.mockReset();
  mocks.beginAgentDeletionRetire.mockReset();
  mocks.readSessionEntrySummariesInWorker.mockReset().mockResolvedValue([]);
  mocks.readAgentDeletionJournal.mockReset().mockReturnValue(undefined);
  mocks.listPendingAgentDeletionJournals.mockReset().mockReturnValue([]);
  mocks.resolveOpenClawAgentSqlitePath
    .mockReset()
    .mockImplementation(
      (params?: { path?: string }) => params?.path ?? "/agents/test-agent/openclaw-agent.sqlite",
    );
  mocks.closeOpenClawAgentDatabaseByPath.mockReset().mockReturnValue(true);
  mocks.listOpenClawRegisteredAgentDatabases.mockReset().mockReturnValue([]);
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
  mocks.resolveAgentWorkspaceDir.mockImplementation(
    (cfg: unknown, agentId?: string) =>
      getAgentList(cfg).find((entry) => entry.id === (agentId ?? ""))?.workspace ??
      "/workspace/" + (agentId ?? ""),
  );
  mocks.rootOpen.mockResolvedValue(makeRootOpen());
  mocks.rootRead.mockResolvedValue(makeRootRead());
  mocks.rootStat.mockImplementation(async ({ rootDir, relativePath }) => {
    const stat = await mocks.fsLstat(path.join(rootDir, relativePath), { bigint: true });
    return {
      dev: stat ? Number(stat.dev) : undefined,
      ino: stat ? Number(stat.ino) : undefined,
      exactIdentity: stat ? { dev: BigInt(stat.dev), ino: BigInt(stat.ino) } : undefined,
      isFile: stat?.isFile?.() ?? true,
      isSymbolicLink: stat?.isSymbolicLink?.() ?? false,
      mtimeMs: Number(stat?.mtimeMs ?? 0),
      nlink: Number(stat?.nlink ?? 1),
      size: Number(stat?.size ?? 0),
    };
  });
  mocks.rootWrite.mockResolvedValue(undefined);
});

function createContext() {
  return {
    getRuntimeConfig: () => mocks.loadConfigReturn,
    dedupe: new Map(),
    cron: { removeAgentJobsTransactional: mocks.cronRemoveAgentJobsTransactional },
    logGateway: { warn: mocks.logGatewayWarn, isEnabled: () => false },
  };
}

function makeCall(method: keyof typeof agentsHandlers, params: Record<string, unknown>) {
  const respond = vi.fn();
  const handler = expectDefined(agentsHandlers[method], "agentsHandlers[method] test invariant");
  const promise = handler({
    params,
    respond,
    context: createContext() as never,
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

function createHarness() {
  return {
    mocks,
    makeCall,
    call,
    makeFileStat,
    createEnoentError,
    resume: () => resumeAgentDeletions(createContext() as never),
    expectTrashedWithinParent,
    expectNotTrashed,
  };
}

async function deleteAgent(expected: Record<string, unknown> = { ok: true }) {
  const result = expectRespondOk(await call("agents.delete", { agentId: "test-agent" }), expected);
  expect(mocks.beginAgentDeletionFinish).toHaveBeenCalledOnce();
  return result;
}

function stageDeletionJournal(journal = deletionJournal()) {
  mocks.loadConfigReturn = agentConfig({ main: {} });
  mocks.readAgentDeletionJournal.mockReturnValue(journal);
  return journal;
}

function journalPath(journal: ReturnType<typeof deletionJournal>, pathname: string) {
  return expectDefined(
    journal.cleanupPaths.find((entry) => entry.path === pathname),
    `cleanup record for ${pathname}`,
  );
}

function trashCalls() {
  return mocks.movePathToTrash.mock.calls.map(([pathname]) => pathname);
}

function mockSymlinkPaths(
  link: string,
  target: string,
  agentDir = link,
  resolve: (pathname: string) => string = (pathname) => pathname.replace(link, target),
) {
  mocks.resolveRegisteredAgentIdForDir.mockImplementation((pathname) =>
    pathname === agentDir ? "test-agent" : undefined,
  );
  mocks.normalizeAgentDirRegistryPath.mockImplementation((pathname) =>
    pathname.replace(link, target),
  );
  mocks.fsRealpath.mockImplementation(async (pathname) => resolve(pathname));
}

function retryTrashOnce(failedPath: string) {
  const trashed = new Set<string>();
  let attempts = 0;
  mocks.movePathToTrash.mockImplementation(async (pathname) => {
    if (pathname === failedPath && attempts++ === 0) {
      throw new Error("workspace trash failed");
    }
    trashed.add(pathname ?? "");
    return "/trashed";
  });
  return trashed;
}

function makeCleanupStat(overrides: Partial<fs.BigIntStats> = {}): fs.BigIntStats {
  return Object.assign(fs.statSync(new URL(import.meta.url), { bigint: true }), {
    dev: 1n,
    ino: 1n,
    nlink: 1n,
    isFile: () => false,
    isSymbolicLink: () => false,
    ...overrides,
  });
}

async function listAgentFiles(agentId = "main") {
  const result = mockCallArg(await call("agents.files.list", { agentId }), 0, 1);
  return (
    result as {
      files: Array<{ name: string; missing: boolean; size?: number; expectedAbsent?: boolean }>;
    }
  ).files;
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
        truncate: async () => {},
        writeFile: async () => {},
        close: async () => {},
      }) as unknown,
  );
  vi.clearAllMocks();
});

registerAgentCreateTests({ mocks, call, createContext, agentsHandlers });

describe("agents.update", () => {
  beforeEach(() => {
    mocks.loadConfigReturn = agentConfig({
      "test-agent": {
        workspace: "/workspace/test-agent",
        identity: { name: "Current Agent", theme: "steady", emoji: "🐢" },
      },
    });
  });

  it("rejects updating a nonexistent agent", async () => {
    mocks.findAgentEntryIndex.mockReturnValue(-1);

    const respond = await call("agents.update", { agentId: "nonexistent" });

    expectNotFoundResponseAndNoWrite(respond);
  });

  it("returns not found when a concurrent delete wins the update race", async () => {
    let findCallCount = 0;
    mocks.findAgentEntryIndex.mockImplementation(() => {
      findCallCount += 1;
      return findCallCount >= 2 ? -1 : 0;
    });

    const respond = await call("agents.update", { agentId: "test-agent", model: "gpt-5.5" });

    expectNotFoundResponseAndNoWrite(respond);
  });

  it("clears an existing model override", async () => {
    mocks.loadConfigReturn = agentConfig(
      {
        "test-agent": {
          workspace: "/workspace/test-agent",
          model: "anthropic/claude-sonnet-4-6",
        },
      },
      { model: { primary: "openai/gpt-5.6-luna" } },
    );

    const respond = await call("agents.update", { agentId: "test-agent", model: null });

    expectRespondOk(respond, { ok: true, agentId: "test-agent" });
    const agent = expectDefined(
      getAgentList(mockCallArg(mocks.writeConfigFile)).find((entry) => entry.id === "test-agent"),
      "persisted test agent",
    );
    expect(agent).not.toHaveProperty("model");
  });

  registerAgentIdentityUpdateTests(createHarness());
});

describe("agents.delete", () => {
  beforeEach(() => {
    mocks.resolveAgentDir.mockImplementation((_cfg?: unknown, agentId?: string) =>
      agentId === "main" ? "/agents/main/agent" : "/agents/test-agent",
    );
    mocks.fsLstat.mockResolvedValue(makeCleanupStat());
    mocks.loadConfigReturn = agentConfig({
      "test-agent": { workspace: "/workspace/test-agent" },
      main: {},
    });
    mocks.pruneAgentConfig.mockImplementation((cfg, agentId) => {
      const config = structuredClone(cfg);
      delete config.agents?.entries?.[agentId];
      return { config, removedBindings: 2 };
    });
    mocks.movePathToTrash.mockReset().mockResolvedValue("/trashed");
    mocks.purgeAgentSessionStoreEntries.mockReset().mockResolvedValue(false);
  });

  const recoveryHarness = createHarness();
  registerAgentDeleteDrainRecoveryTests(recoveryHarness);

  it("rejects deleting the auth-inheritance owner before starting cleanup", async () => {
    mocks.sharedAuthStoreOwnership = { location: "state-db" };
    mocks.loadConfigReturn = agentConfig(
      { "test-agent": { workspace: "/workspace/test-agent" }, main: {} },
      { authInheritance: { agentId: "test-agent" } },
    );
    const respond = await call("agents.delete", { agentId: "test-agent" });

    expectRespondErrorContaining(respond, "agents.defaults.authInheritance.agentId");
    expectUncalled(
      mocks.cronRemoveAgentJobsTransactional,
      mocks.writeConfigFile,
      mocks.movePathToTrash,
    );
  });

  registerAgentDeletionAuthorityTests({ mocks, call });

  registerAgentDeleteRollbackTests(recoveryHarness);

  it.each([false, true])(
    "preserves deletion authority without a mutation result (committed=%s)",
    async (committed) => {
      mocks.omitConfigMutationResult = true;
      if (!committed) {
        mocks.pruneAgentConfig.mockReturnValueOnce({
          config: mocks.loadConfigReturn,
          removedBindings: 0,
        });
      }

      const { promise } = makeCall("agents.delete", { agentId: "test-agent" });

      await expect(promise).rejects.toThrow("config mutation did not return its target");
      expect(mocks.movePathToTrash).not.toHaveBeenCalled();
      expect(mocks.beginAgentDeletionFinish).not.toHaveBeenCalledWith({
        unregisterDatabases: true,
      });
      if (committed) {
        expect(mocks.beginAgentDeletionRollback).not.toHaveBeenCalled();
      } else {
        expect(mocks.closeOpenClawAgentDatabaseByPath).toHaveBeenCalledTimes(1);
        expect(mocks.beginAgentDeletionRollback).toHaveBeenCalledOnce();
      }
    },
  );

  it("converges after partial cleanup and makes the agent id recreatable", async () => {
    const journal = deletionJournal({
      agentDir: "/agents/test-agent",
      workspaceDir: "/workspace/test-agent",
      sessionsDir: "/transcripts/test-agent",
    });
    const trashed = retryTrashOnce(journal.workspaceDir);
    mocks.fsLstat.mockImplementation(async (pathname: unknown) => {
      if (trashed.has(String(pathname))) {
        throw createEnoentError();
      }
      return makeCleanupStat();
    });

    mocks.beginAgentDeletionFinish.mockImplementation(() => {
      journal.cleanupCompleted = true;
    });
    mocks.readAgentDeletionJournal.mockReturnValue(journal);

    expectPendingDeletion(await call("agents.delete", { agentId: "test-agent" }), {
      failed: [{ path: journal.workspaceDir, reason: "workspace trash failed" }],
    });
    expect(mocks.purgeAgentSessionStoreEntries.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.closeDeletedAgentDatabases.mock.invocationCallOrder[0]!,
    );
    expect(mocks.closeDeletedAgentDatabases.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.movePathToTrash.mock.invocationCallOrder[0]!,
    );
    expect(mocks.beginAgentDeletionFinish).not.toHaveBeenCalled();
    expect(mocks.unregisterResolvedAgentDir).toHaveBeenCalledWith({
      agentId: "test-agent",
      agentDir: journal.agentDir,
    });
    expect(journalPath(journal, journal.agentDir).done).toBe(true);
    const agentDirMoveCount = trashCalls().filter(
      (pathname) => pathname === journal.agentDir,
    ).length;
    trashed.delete(journal.agentDir);
    mocks.readAgentDeletionJournal.mockReturnValue(journal);
    expectRespondErrorContaining(
      await call("agents.create", { name: "Test Agent" }),
      "still pending",
    );

    mocks.closeDeletedAgentDatabases.mockRejectedValueOnce(new Error("native reader close failed"));
    const trashAttempts = mocks.movePathToTrash.mock.calls.length;
    const failedClose = makeCall("agents.delete", { agentId: "test-agent" });
    await expect(failedClose.promise).rejects.toThrow("native reader close failed");
    expect(mocks.movePathToTrash).toHaveBeenCalledTimes(trashAttempts);
    expect(mocks.beginAgentDeletionFinish).not.toHaveBeenCalled();
    expect(journal.cleanupCompleted).toBe(false);

    await deleteAgent({ failed: [] });
    expect(trashCalls().filter((pathname) => pathname === journal.agentDir)).toHaveLength(
      agentDirMoveCount,
    );
    expect(trashed.has(journal.agentDir)).toBe(false);
    expect(journal.cleanupCompleted).toBe(true);
    expectRespondOk(await call("agents.create", { name: "Test Agent" }), {
      ok: true,
      agentId: "test-agent",
    });
  });

  it("sweeps leaked files that appeared at prepared-absent journal paths", async () => {
    const workspaceDir = "/journal/workspace";
    const workspaceAlias = "/journal/workspace-alias";
    const journal = deletionJournal({
      workspaceDir,
      databasePaths: [workspaceAlias],
      cleanupPaths: [
        cleanupPath("/journal/agent", { dev: 1, ino: 10, done: true }),
        cleanupPath(workspaceDir, { parentPath: "/journal" }),
        cleanupPath("/journal/sessions", { dev: 1, ino: 30, done: true }),
      ],
    });
    stageDeletionJournal(journal);
    mocks.fsRealpath.mockImplementation(async (pathname: string) =>
      pathname === workspaceAlias ? workspaceDir : pathname,
    );
    mocks.fsLstat.mockImplementation(async (pathname: unknown) =>
      makeCleanupStat({ dev: 2n, ino: pathname === workspaceDir ? 200n : 100n }),
    );

    await deleteAgent({ failed: [] });
    expectTrashedWithinParent(workspaceDir);
    const appearedRecord = journalPath(journal, workspaceDir);
    expect(appearedRecord).toMatchObject({ done: true });
    expect(appearedRecord).not.toHaveProperty("note");
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
        cleanupPath(workspaceDir, { parentPath: "/journal", dev: 1, ino: 20 }),
      ],
    });
    stageDeletionJournal(journal);
    mocks.fsLstat.mockImplementation(async (pathname: unknown) => {
      if (pathname !== completedChild && pathname !== workspaceDir) {
        throw createEnoentError();
      }
      return makeCleanupStat({
        dev: pathname === completedChild ? 2n : 1n,
        ino: pathname === completedChild ? 100n : 20n,
      });
    });

    await deleteAgent({ failed: [] });
    expectNotTrashed(completedChild, workspaceDir);
    expect(journalPath(journal, workspaceDir)).toMatchObject({
      done: true,
      note: "completed cleanup path is occupied; replacement preserved",
    });
  });

  it("treats a source that disappears during Trash as successful cleanup", async () => {
    let workspaceLstatCalls = 0;
    mocks.fsLstat.mockImplementation(async (pathname: unknown) => {
      if (pathname === "/workspace/test-agent" && workspaceLstatCalls++ > 1) {
        throw createEnoentError();
      }
      return makeCleanupStat();
    });
    mocks.movePathToTrash.mockImplementation(async (pathname?: string) => {
      if (pathname === "/workspace/test-agent") {
        throw createEnoentError();
      }
      return "/trashed";
    });

    const result = await deleteAgent({ failed: [] });
    expect(result.removed).toEqual(
      expect.arrayContaining([{ path: "/workspace/test-agent", method: "missing" }]),
    );
  });

  it("does not move a symlink ancestor when its canonical descendant fails", async () => {
    const agentLink = "/deep/journal/link";
    const agentTarget = "/target";
    stageDeletionJournal(
      deletionJournal({
        agentDir: agentLink,
        workspaceDir: "/deep",
        sessionsDir: "/deep/sessions",
      }),
    );
    mockSymlinkPaths(agentLink, agentTarget);
    mocks.fsLstat.mockImplementation(async (pathname: unknown) =>
      makeCleanupStat({ isSymbolicLink: () => pathname === agentLink }),
    );
    mocks.movePathToTrash.mockImplementation(async (pathname) => {
      if (pathname === agentTarget) {
        throw new Error("agent trash failed");
      }
      return "/trashed";
    });

    const respond = await call("agents.delete", { agentId: "test-agent" });

    expectPendingDeletion(respond, {
      failed: [{ path: agentTarget, reason: "agent trash failed" }],
    });
    expectNotTrashed(agentLink, "/deep");
    expectTrashedWithinParent(agentTarget, agentLink);
    expectUncalled(mocks.unregisterResolvedAgentDir, mocks.beginAgentDeletionFinish);
  });

  it("does not trash a replacement at a journaled symlink path", async () => {
    const workspaceLink = "/journal/workspace-link";
    const journal = deletionJournal({
      workspaceDir: workspaceLink,
      cleanupPaths: [
        cleanupPath("/canonical/workspace", { sourcePaths: [workspaceLink] }),
        cleanupPath(workspaceLink, {
          parentPath: "/journal",
          kind: "symlink",
          coversDescendants: false,
        }),
        cleanupPath("/journal/agent"),
        cleanupPath("/journal/sessions"),
      ],
    });
    stageDeletionJournal(journal);

    await deleteAgent({ failed: [] });
    expectNotTrashed(workspaceLink);
    expect(journalPath(journal, workspaceLink)).toMatchObject({
      done: true,
      note: "cleanup path changed from symlink before deletion",
    });
  });

  it("resolves a symlinked workspace and removes descendants before its target and link", async () => {
    const workspaceParent = "/tmp-root";
    const workspaceParentTarget = "/real-tmp/source-parent";
    const workspaceLink = `${workspaceParent}/workspace-link`;
    const canonicalWorkspaceLink = `${workspaceParentTarget}/workspace-link`;
    const workspaceTarget = "/real-tmp/workspace";
    const agentDir = `${workspaceLink}/agent`;
    const sessionsDir = `${workspaceLink}/transcripts`;
    stageDeletionJournal(deletionJournal({ agentDir, workspaceDir: workspaceLink, sessionsDir }));
    mockSymlinkPaths(workspaceLink, workspaceTarget, agentDir, (pathname) =>
      pathname === workspaceParent
        ? workspaceParentTarget
        : pathname.replace(workspaceLink, workspaceTarget),
    );
    mocks.fsLstat.mockImplementation(async (pathname: unknown) =>
      makeCleanupStat({
        isSymbolicLink: () => pathname === workspaceLink || pathname === canonicalWorkspaceLink,
      }),
    );

    await deleteAgent({ failed: [] });
    const trashedPaths = trashCalls();
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

    expectUncalled(respond, mocks.writeConfigFile, mocks.movePathToTrash);
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
    const trashed = retryTrashOnce(originalTarget);
    stageDeletionJournal(journal);
    mockSymlinkPaths(workspaceLink, originalTarget, journal.agentDir, (pathname) => {
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
      return makeCleanupStat({ isSymbolicLink: () => pathname === workspaceLink });
    });

    expectPendingDeletion(await call("agents.delete", { agentId: "test-agent" }), {
      failed: [{ path: originalTarget, reason: "workspace trash failed" }],
    });
    expect(mocks.beginAgentDeletionFinish).not.toHaveBeenCalled();
    expect(journal).toHaveProperty("cleanupPaths");

    mocks.fsRealpath.mockClear();
    mocks.fsRealpath.mockImplementation(async (pathname: string) =>
      pathname.replace(workspaceLink, retargetedWorkspace),
    );
    await deleteAgent({ failed: [] });
    expect(mocks.fsRealpath).not.toHaveBeenCalled();
    expectNotTrashed(
      missingTranscriptTarget,
      retargetedWorkspace,
      `${retargetedWorkspace}/transcripts`,
    );
    expectTrashedWithinParent(originalTarget, workspaceLink);
    expectTrashedWithinParent(workspaceLink);
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
    stageDeletionJournal(journal);
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

    const result = expectPendingDeletion(respond, {});
    expect(result.failed).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ reason: "cleanup path parent changed before deletion" }),
      ]),
    );
    expect(trashCalls().some((pathname) => String(pathname).startsWith(unrelatedRoot))).toBe(false);
    expect(mocks.beginAgentDeletionFinish).not.toHaveBeenCalled();
  });

  it.each<[string, string | number, boolean, number?, bigint?, bigint?]>([
    ["released numeric", 123, false],
    ["released numeric", 123, true],
    ["released rounded numeric", 9_007_199_254_740_992, false],
    ["released rounded numeric", 9_007_199_254_740_992, true],
    ["exact full-width", "9007199254740992", false],
    ["exact full-width", "9007199254740992", true],
    [
      "released unsigned high-bit",
      9_223_372_036_854_775_808,
      false,
      9_223_372_036_854_775_808,
      -9_223_372_036_854_775_808n,
      -9_223_372_036_854_775_807n,
    ],
    [
      "released unsigned high-bit",
      9_223_372_036_854_775_808,
      true,
      42,
      42n,
      -9_223_372_036_854_771_712n,
    ],
    ["exact signed high-bit", "-9223372036854775808", false],
    ["exact signed high-bit", "-9223372036854775808", true],
  ])(
    "resumes %s cleanup (inode=%s, replaced=%s)",
    async (_encoding, savedIno, replaced, inputDev, inputObservedDev, suppliedIno) => {
      const savedDev = inputDev ?? 42;
      const observedDev = inputObservedDev ?? 42n;
      const workspaceDir = path.resolve("/journal/workspace");
      // v2026.10.2 persisted the prepared numeric identity in cleanup_paths_json.
      const journal = deletionJournal({
        workspaceDir,
        cleanupPaths: [cleanupPath(workspaceDir, { dev: savedDev, ino: savedIno })],
      });
      mocks.loadConfigReturn = agentConfig({ main: {} });
      mocks.readAgentDeletionJournal.mockReturnValue(journal);
      const observedIno =
        suppliedIno ??
        (typeof savedIno === "number" && !Number.isSafeInteger(savedIno)
          ? BigInt(savedIno) + (replaced ? 3n : 1n)
          : BigInt(savedIno) + (replaced ? 1n : 0n));
      mocks.fsLstat.mockResolvedValue(makeCleanupStat({ dev: observedDev, ino: observedIno }));

      const respond = await call("agents.delete", { agentId: "test-agent" });

      expectRespondOk(respond, { ok: true, failed: [] });
      const retainedPath = journalPath(journal, workspaceDir);
      expect(retainedPath).toMatchObject({ done: true });
      if (replaced) {
        expectNotTrashed(workspaceDir);
        expect(retainedPath).toMatchObject({
          note: "cleanup path identity changed before deletion",
        });
      } else {
        expectTrashedWithinParent(workspaceDir);
        expect(retainedPath).not.toHaveProperty("note");
        expect(retainedPath).toMatchObject({ dev: String(observedDev), ino: String(observedIno) });
      }
      expect(mocks.beginAgentDeletionFinish).toHaveBeenCalledOnce();
    },
  );

  it("reclaims durable journal ownership after a process restart", async () => {
    const directoryOwners = new Map<string, string>();
    stageDeletionJournal(deletionJournal());
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

    await deleteAgent();
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
  });

  it("revalidates database ownership after earlier filesystem cleanup", async () => {
    let claimed = false;
    stageDeletionJournal(deletionJournal());
    mocks.listOpenClawRegisteredAgentDatabases.mockImplementation(() =>
      claimed ? [{ agentId: "other-agent", path: "/journal/agent/survivor.sqlite" }] : [],
    );
    mocks.movePathToTrash.mockImplementation(async (pathname?: string) => {
      if (pathname === "/journal/agent/openclaw-agent.sqlite") {
        claimed = true;
      }
      return "/trashed";
    });

    await deleteAgent();
    expectTrashedWithinParent("/journal/agent/openclaw-agent.sqlite");
    expectTrashedWithinParent("/journal/workspace");
    expectNotTrashed("/journal/agent", "/journal/agent/survivor.sqlite");
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

    await deleteAgent();
    expect(mocks.closeOpenClawAgentDatabaseByPath).toHaveBeenCalledTimes(2);
    expect(mocks.closeOpenClawAgentDatabaseByPath).toHaveBeenCalledWith(
      "/agents/test-agent/openclaw-agent.sqlite",
      "test-agent",
    );
    expect(mocks.closeOpenClawAgentDatabaseByPath).toHaveBeenCalledWith(
      "/linked/shared/agent.sqlite",
      "test-agent",
    );
    expectNotTrashed("/linked/shared/agent.sqlite", "/linked/shared/agent.sqlite-wal");
    expect(mocks.closeDeletedAgentDatabases).toHaveBeenCalledWith(
      "test-agent",
      ["/agents/test-agent/openclaw-agent.sqlite"],
      expect.objectContaining({
        assertCurrentFinal: mocks.assertAgentDeletionCurrentFinal,
        assertCurrentAsync: mocks.assertAgentDeletionCurrentAsync,
      }),
    );
    expect(mocks.beginAgentDeletionFinish).toHaveBeenCalledWith({ unregisterDatabases: true });
  });

  it("preserves the original keep-files intent while recovering deletion", async () => {
    stageDeletionJournal(deletionJournal({ deleteFiles: false }));

    await deleteAgent({ ok: true, removed: [], failed: [] });
    expect(mocks.movePathToTrash).not.toHaveBeenCalled();
    expect(mocks.beginAgentDeletionFinish).not.toHaveBeenCalledWith({ unregisterDatabases: true });
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

    const respond = await call("agents.delete", { agentId: "test-agent", deleteFiles: false });

    expectRespondOk(respond, { ok: true, removed: [], failed: [] });
    expect(mocks.claimCompletedAgentDeletion).toHaveBeenCalledWith("test-agent", "old-delete");
    expectUncalled(mocks.movePathToTrash, mocks.fsLstat, mocks.deleteWorkspaceState);
    expect(mocks.beginAgentDeletionFinish).not.toHaveBeenCalledWith({ unregisterDatabases: true });
  });

  it("reports failed session cleanup and retains its journal and files for retry", async () => {
    const failure = {
      path: "/agents/test-agent/openclaw-agent.sqlite",
      reason: "admit session-store cleanup: agent database is still open",
    };
    mocks.purgeAgentSessionStoreEntries.mockImplementationOnce(async (_cfg, _agentId, options) => {
      options?.onFailure?.(failure);
      return true;
    });
    const respond = await call("agents.delete", { agentId: "test-agent" });

    expectPendingDeletion(respond, { ok: true, purgeFailed: true, failed: [failure] });
    expect(mockCallArg(respond, 0, 2)).toMatchObject({
      message: expect.stringContaining(`${failure.path}: ${failure.reason}`),
    });
    expectUncalled(mocks.movePathToTrash, mocks.beginAgentDeletionFinish);
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
      return makeCleanupStat({
        dev: BigInt(stat.dev),
        ino: BigInt(stat.ino),
        isFile: () => stat.file,
      });
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

    await deleteAgent({ failed: [] });
    expect(trashCalls()).toEqual(expect.arrayContaining([walPath, shmPath, agentDir]));
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
        expectUncalled(mocks.closeDeletedAgentDatabases, mocks.movePathToTrash);
      }
      expect(mocks.beginAgentDeletionFinish).not.toHaveBeenCalledWith({
        unregisterDatabases: true,
      });
      expectUncalled(mocks.unregisterResolvedAgentDir, mocks.beginAgentDeletionFinish);
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
    mocks.loadConfigReturn = agentConfig({ main: {}, ops: {} });
    const respond = await call("agents.delete", { agentId: "main" });

    expectRespondErrorContaining(respond, "owns the legacy shared auth store");
    expectRespondErrorContaining(respond, "openclaw doctor --fix");
    expect(mocks.writeConfigFile).not.toHaveBeenCalled();
  });

  it("rejects an unrepresentable id before targeting the main agent", async () => {
    mocks.sharedAuthStoreOwnership = { location: "state-db" };
    mocks.loadConfigReturn = agentConfig({ main: {}, ops: {} });

    const respond = await call("agents.delete", { agentId: "агент✨" });

    expectRespondErrorContaining(respond, 'agent "агент✨" not found');
    expectUncalled(mocks.writeConfigFile, mocks.movePathToTrash);
  });

  it("rejects invalid params (missing agentId)", async () => {
    const respond = await call("agents.delete", {});

    expectRespondErrorContaining(respond, "invalid");
  });

  it("returns not found after a previous deletion removed the agent", async () => {
    const first = await call("agents.delete", { agentId: "test-agent", deleteFiles: false });
    expectRespondOk(first, { ok: true });
    mocks.writeConfigFile.mockClear();

    const second = await call("agents.delete", { agentId: "test-agent", deleteFiles: false });

    expectNotFoundResponseAndNoWrite(second);
    expect(mocks.movePathToTrash).not.toHaveBeenCalled();
  });
});

describe("agents.files.list", () => {
  beforeEach(() => {
    mocks.isWorkspaceSetupCompleted.mockReset().mockResolvedValue(false);
  });

  // A private list once left a retired file visible as a permanently-missing tab.
  it("lists the canonical filenames without BOOTSTRAP.md once setup completed", async () => {
    mocks.isWorkspaceSetupCompleted.mockResolvedValue(true);
    const names = (await listAgentFiles()).map((file) => file.name);
    expect(names).toStrictEqual(
      WORKSPACE_BOOTSTRAP_FILENAMES.filter(
        (name) => name !== "IDENTITY.md" && name !== "BOOTSTRAP.md",
      ),
    );
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
    expectUncalled(mocks.fsMkdir, mocks.rootWrite);
  });

  // Clients merge get over list; dropping expectedAbsent turned optional files into faults.
  it("carries expectedAbsent through agents.files.get for a missing file", async () => {
    mocks.rootRead.mockRejectedValue(new FsSafeError("not-found", "no such file"));

    const respond = await call("agents.files.get", { agentId: "main", name: "SOUL.md" });

    const result = mockCallArg(respond, 0, 1);
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
        return { isFile: true, isSymbolicLink: false, mtimeMs: 4567, nlink: 1, size: 17 };
      }
      throw createEnoentError();
    });

    const files = await listAgentFiles();
    const names = files.map((file) => file.name);
    expect(names).toStrictEqual(
      WORKSPACE_BOOTSTRAP_FILENAMES.filter((name) => name !== "IDENTITY.md"),
    );
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
    expectRecordFields(file, { name: "AGENTS.md", missing: false, size: 17 });
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

    const file = (await listAgentFiles()).find((entry) => entry.name === "AGENTS.md");
    expectRecordFields(file, { name: "AGENTS.md", missing: true });
    expect(file).not.toHaveProperty("size");
  });
});

describe("agents.files.get/set symlink safety", () => {
  beforeEach(() => {
    mocks.loadConfigReturn = agentConfig({ main: { workspace: "/workspace/test-agent" } });
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
    mocks.rootRead.mockResolvedValue({ ...makeRootRead("hello"), stat: makeFileStat({ size: 5 }) });

    const respond = await call("agents.files.get", { agentId: "main", name: "AGENTS.md" });

    expectRecordFields(mockCallArg(mocks.rootRead), {
      rootDir: "/workspace/test-agent",
      relativePath: "AGENTS.md",
      hardlinks: "reject",
    });
    const payload = expectRespondOk(respond, {});
    expectRecordFields(payload.file, { name: "AGENTS.md", content: "hello" });
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
