import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";

const TEST_WORKSPACE_ROOT = path.resolve("/tmp/workspace");

function createManagerStatus(params: {
  backend: "qmd" | "builtin";
  provider: string;
  model: string;
  requestedProvider: string;
  withMemorySourceCounts?: boolean;
}) {
  const base = {
    backend: params.backend,
    provider: params.provider,
    model: params.model,
    requestedProvider: params.requestedProvider,
    files: 0,
    chunks: 0,
    dirty: false,
    workspaceDir: "/tmp",
    dbPath: "/tmp/index.sqlite",
  };
  if (!params.withMemorySourceCounts) {
    return base;
  }
  return {
    ...base,
    sources: ["memory" as const],
    sourceCounts: [{ source: "memory" as const, files: 0, chunks: 0 }],
  };
}

const mockPrimary = vi.hoisted(() => ({
  search: vi.fn(async () => []),
  readFile: vi.fn(async () => ({ text: "", path: "MEMORY.md" })),
  status: vi.fn(() =>
    createManagerStatus({
      backend: "qmd",
      provider: "qmd",
      model: "qmd",
      requestedProvider: "qmd",
      withMemorySourceCounts: true,
    }),
  ),
  sync: vi.fn(async () => {}),
  probeEmbeddingAvailability: vi.fn(async () => ({ ok: true })),
  probeVectorAvailability: vi.fn(async () => true),
  close: vi.fn(async () => {}),
}));

const fallbackManager = vi.hoisted(() => ({
  search: vi.fn(async () => [
    {
      path: "MEMORY.md",
      startLine: 1,
      endLine: 1,
      score: 1,
      snippet: "fallback",
      source: "memory" as const,
    },
  ]),
  readFile: vi.fn(async () => ({ text: "", path: "MEMORY.md" })),
  status: vi.fn(() =>
    createManagerStatus({
      backend: "builtin",
      provider: "openai",
      model: "text-embedding-3-small",
      requestedProvider: "openai",
    }),
  ),
  sync: vi.fn(async () => {}),
  probeEmbeddingAvailability: vi.fn(async () => ({ ok: true })),
  probeVectorAvailability: vi.fn(async () => true),
  close: vi.fn(async () => {}),
}));

const fallbackSearch = fallbackManager.search;
const mockMemoryIndexGet = vi.hoisted(() => vi.fn(async () => fallbackManager));
const mockCloseAllMemoryIndexManagers = vi.hoisted(() => vi.fn(async () => {}));
const readMemoryDocumentFromPostgresMock = vi.hoisted(() =>
  vi.fn<() => Promise<string | null>>(async () => null),
);
const reconcileMemoryDocumentFromFilesystemToPostgresMock = vi.hoisted(() =>
  vi.fn<() => Promise<boolean>>(async () => true),
);
const reconcileWorkspaceMemoryDocumentsToPostgresMock = vi.hoisted(() =>
  vi.fn<() => Promise<{ upserted: number; deleted: number }>>(async () => ({
    upserted: 0,
    deleted: 0,
  })),
);

vi.mock("./qmd-manager.js", () => ({
  QmdMemoryManager: {
    create: vi.fn(async () => mockPrimary),
  },
}));

vi.mock("./manager-runtime.js", () => ({
  MemoryIndexManager: {
    get: mockMemoryIndexGet,
  },
  closeAllMemoryIndexManagers: mockCloseAllMemoryIndexManagers,
}));

vi.mock("../persistence/service.js", () => ({
  readMemoryDocumentFromPostgres: readMemoryDocumentFromPostgresMock,
  reconcileMemoryDocumentFromFilesystemToPostgres:
    reconcileMemoryDocumentFromFilesystemToPostgresMock,
  reconcileWorkspaceMemoryDocumentsToPostgres: reconcileWorkspaceMemoryDocumentsToPostgresMock,
}));

import { QmdMemoryManager } from "./qmd-manager.js";
import { closeAllMemorySearchManagers, getMemorySearchManager } from "./search-manager.js";
// eslint-disable-next-line @typescript-eslint/unbound-method -- mocked static function
const createQmdManagerMock = vi.mocked(QmdMemoryManager.create);

type SearchManagerResult = Awaited<ReturnType<typeof getMemorySearchManager>>;
type SearchManager = NonNullable<SearchManagerResult["manager"]>;

function createQmdCfg(agentId: string): OpenClawConfig {
  return {
    memory: { backend: "qmd", qmd: {} },
    agents: { list: [{ id: agentId, default: true, workspace: TEST_WORKSPACE_ROOT }] },
  };
}

function requireManager(result: SearchManagerResult): SearchManager {
  expect(result.manager).toBeTruthy();
  if (!result.manager) {
    throw new Error("manager missing");
  }
  return result.manager;
}

async function createFailedQmdSearchHarness(params: { agentId: string; errorMessage: string }) {
  const cfg = createQmdCfg(params.agentId);
  mockPrimary.search.mockRejectedValueOnce(new Error(params.errorMessage));
  const first = await getMemorySearchManager({ cfg, agentId: params.agentId });
  return { cfg, manager: requireManager(first), firstResult: first };
}

beforeEach(async () => {
  await closeAllMemorySearchManagers();
  mockPrimary.search.mockClear();
  mockPrimary.readFile.mockClear();
  mockPrimary.status.mockClear();
  mockPrimary.sync.mockClear();
  mockPrimary.probeEmbeddingAvailability.mockClear();
  mockPrimary.probeVectorAvailability.mockClear();
  mockPrimary.close.mockClear();
  fallbackSearch.mockClear();
  fallbackManager.readFile.mockClear();
  fallbackManager.status.mockClear();
  fallbackManager.sync.mockClear();
  fallbackManager.probeEmbeddingAvailability.mockClear();
  fallbackManager.probeVectorAvailability.mockClear();
  fallbackManager.close.mockClear();
  mockCloseAllMemoryIndexManagers.mockClear();
  mockMemoryIndexGet.mockClear();
  mockMemoryIndexGet.mockResolvedValue(fallbackManager);
  createQmdManagerMock.mockClear();
  readMemoryDocumentFromPostgresMock.mockClear();
  readMemoryDocumentFromPostgresMock.mockResolvedValue(null);
  reconcileMemoryDocumentFromFilesystemToPostgresMock.mockClear();
  reconcileMemoryDocumentFromFilesystemToPostgresMock.mockResolvedValue(true);
  reconcileWorkspaceMemoryDocumentsToPostgresMock.mockClear();
  reconcileWorkspaceMemoryDocumentsToPostgresMock.mockResolvedValue({ upserted: 0, deleted: 0 });
});

describe("getMemorySearchManager caching", () => {
  it("reuses the same QMD manager instance for repeated calls", async () => {
    const cfg = createQmdCfg("main");

    const first = await getMemorySearchManager({ cfg, agentId: "main" });
    const second = await getMemorySearchManager({ cfg, agentId: "main" });

    expect(first.manager).toBe(second.manager);
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(createQmdManagerMock).toHaveBeenCalledTimes(1);
  });

  it("evicts failed qmd wrapper so next call retries qmd", async () => {
    const retryAgentId = "retry-agent";
    const {
      cfg,
      manager: firstManager,
      firstResult: first,
    } = await createFailedQmdSearchHarness({
      agentId: retryAgentId,
      errorMessage: "qmd query failed",
    });

    const fallbackResults = await firstManager.search("hello");
    expect(fallbackResults).toHaveLength(1);
    expect(fallbackResults[0]?.path).toBe("MEMORY.md");

    const second = await getMemorySearchManager({ cfg, agentId: retryAgentId });
    requireManager(second);
    expect(second.manager).not.toBe(first.manager);
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(createQmdManagerMock).toHaveBeenCalledTimes(2);
  });

  it("does not cache status-only qmd managers", async () => {
    const agentId = "status-agent";
    const cfg = createQmdCfg(agentId);

    const first = await getMemorySearchManager({ cfg, agentId, purpose: "status" });
    const second = await getMemorySearchManager({ cfg, agentId, purpose: "status" });

    requireManager(first);
    requireManager(second);
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(createQmdManagerMock).toHaveBeenCalledTimes(2);
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(createQmdManagerMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ agentId, mode: "status" }),
    );
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(createQmdManagerMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ agentId, mode: "status" }),
    );
  });

  it("does not evict a newer cached wrapper when closing an older failed wrapper", async () => {
    const retryAgentId = "retry-agent-close";
    const {
      cfg,
      manager: firstManager,
      firstResult: first,
    } = await createFailedQmdSearchHarness({
      agentId: retryAgentId,
      errorMessage: "qmd query failed",
    });
    await firstManager.search("hello");

    const second = await getMemorySearchManager({ cfg, agentId: retryAgentId });
    const secondManager = requireManager(second);
    expect(second.manager).not.toBe(first.manager);

    await firstManager.close?.();

    const third = await getMemorySearchManager({ cfg, agentId: retryAgentId });
    expect(third.manager).toBe(secondManager);
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(createQmdManagerMock).toHaveBeenCalledTimes(2);
  });

  it("falls back to builtin search when qmd fails with sqlite busy", async () => {
    const retryAgentId = "retry-agent-busy";
    const { manager: firstManager } = await createFailedQmdSearchHarness({
      agentId: retryAgentId,
      errorMessage: "qmd index busy while reading results: SQLITE_BUSY: database is locked",
    });

    const results = await firstManager.search("hello");
    expect(results).toHaveLength(1);
    expect(results[0]?.path).toBe("MEMORY.md");
    expect(fallbackSearch).toHaveBeenCalledTimes(1);
  });

  it("keeps original qmd error when fallback manager initialization fails", async () => {
    const retryAgentId = "retry-agent-no-fallback-auth";
    const { manager: firstManager } = await createFailedQmdSearchHarness({
      agentId: retryAgentId,
      errorMessage: "qmd query failed",
    });
    mockMemoryIndexGet.mockRejectedValueOnce(new Error("No API key found for provider openai"));

    await expect(firstManager.search("hello")).rejects.toThrow("qmd query failed");
  });

  it("closes cached managers on global teardown", async () => {
    const cfg = createQmdCfg("teardown-agent");
    const first = await getMemorySearchManager({ cfg, agentId: "teardown-agent" });
    const firstManager = requireManager(first);

    await closeAllMemorySearchManagers();

    expect(mockPrimary.close).toHaveBeenCalledTimes(1);
    expect(mockCloseAllMemoryIndexManagers).toHaveBeenCalledTimes(1);

    const second = await getMemorySearchManager({ cfg, agentId: "teardown-agent" });
    expect(second.manager).toBeTruthy();
    expect(second.manager).not.toBe(firstManager);
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(createQmdManagerMock).toHaveBeenCalledTimes(2);
  });

  it("closes builtin index managers on teardown after runtime is loaded", async () => {
    const retryAgentId = "teardown-with-fallback";
    const { manager } = await createFailedQmdSearchHarness({
      agentId: retryAgentId,
      errorMessage: "qmd query failed",
    });
    await manager.search("hello");

    await closeAllMemorySearchManagers();

    expect(mockCloseAllMemoryIndexManagers).toHaveBeenCalledTimes(1);
  });

  it("prefers postgres-backed memory documents for readFile when configured", async () => {
    const cfg = {
      ...createQmdCfg("postgres-memory"),
      persistence: {
        backend: "postgres" as const,
        postgres: {
          url: "postgresql://openclaw:test@localhost/openclaw",
        },
      },
    };
    readMemoryDocumentFromPostgresMock.mockResolvedValue("line 1\nline 2\nline 3");

    const result = await getMemorySearchManager({ cfg, agentId: "postgres-memory" });
    const manager = requireManager(result);
    const read = await manager.readFile({ relPath: "MEMORY.md", from: 2, lines: 1 });

    expect(read).toEqual({ text: "line 2", path: "MEMORY.md" });
    expect(reconcileMemoryDocumentFromFilesystemToPostgresMock).not.toHaveBeenCalled();
    expect(readMemoryDocumentFromPostgresMock).toHaveBeenCalledWith({
      config: cfg,
      lookupMode: "runtime",
      workspaceRoot: TEST_WORKSPACE_ROOT,
      logicalPath: "MEMORY.md",
    });
    expect(mockPrimary.readFile).not.toHaveBeenCalled();
  });

  it("fails closed when postgres has no memory document", async () => {
    const cfg = {
      ...createQmdCfg("postgres-fallback"),
      persistence: {
        backend: "postgres" as const,
        postgres: {
          url: "postgresql://openclaw:test@localhost/openclaw",
        },
      },
    };

    const result = await getMemorySearchManager({ cfg, agentId: "postgres-fallback" });
    const manager = requireManager(result);
    await expect(manager.readFile({ relPath: "MEMORY.md" })).rejects.toThrow(
      "Memory document is unavailable in Postgres for MEMORY.md.",
    );
    expect(reconcileMemoryDocumentFromFilesystemToPostgresMock).not.toHaveBeenCalled();
    expect(mockPrimary.readFile).not.toHaveBeenCalled();
  });

  it("keeps memory_get available from postgres when index startup fails", async () => {
    const cfg = {
      ...createQmdCfg("postgres-read-through"),
      persistence: {
        backend: "postgres" as const,
        postgres: {
          url: "postgresql://openclaw:test@localhost/openclaw",
        },
      },
    };
    createQmdManagerMock.mockRejectedValueOnce(new Error("qmd missing"));
    mockMemoryIndexGet.mockRejectedValueOnce(new Error("builtin unavailable"));
    readMemoryDocumentFromPostgresMock.mockResolvedValue("canonical line");

    const result = await getMemorySearchManager({ cfg, agentId: "postgres-read-through" });
    const manager = requireManager(result);

    await expect(manager.search("hello")).rejects.toThrow("builtin unavailable");
    await expect(manager.readFile({ relPath: "MEMORY.md" })).resolves.toEqual({
      text: "canonical line",
      path: "MEMORY.md",
    });
  });

  it("reconciles workspace memory documents after sync when postgres is configured", async () => {
    const cfg = {
      ...createQmdCfg("postgres-sync"),
      persistence: {
        backend: "postgres" as const,
        postgres: {
          url: "postgresql://openclaw:test@localhost/openclaw",
        },
      },
    };

    const result = await getMemorySearchManager({ cfg, agentId: "postgres-sync" });
    const manager = requireManager(result);
    await manager.sync?.({ reason: "watch", force: true });

    expect(mockPrimary.sync).toHaveBeenCalledWith({ reason: "watch", force: true });
    expect(reconcileWorkspaceMemoryDocumentsToPostgresMock).toHaveBeenCalledWith(
      {
        workspaceRoot: TEST_WORKSPACE_ROOT,
        agentId: "postgres-sync",
      },
      {
        config: cfg,
        lookupMode: "runtime",
      },
    );
  });

  it("skips filesystem reconcile during sync when postgres exports are disabled", async () => {
    const cfg = {
      ...createQmdCfg("postgres-sync-no-export"),
      persistence: {
        backend: "postgres" as const,
        postgres: {
          url: "postgresql://openclaw:test@localhost/openclaw",
          exportCompatibility: false,
        },
      },
    };

    const result = await getMemorySearchManager({ cfg, agentId: "postgres-sync-no-export" });
    const manager = requireManager(result);
    await manager.sync?.({ reason: "watch", force: true });

    expect(mockPrimary.sync).toHaveBeenCalledWith({ reason: "watch", force: true });
    expect(reconcileWorkspaceMemoryDocumentsToPostgresMock).not.toHaveBeenCalled();
  });
});
