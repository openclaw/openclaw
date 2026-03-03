import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";

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

const qmdManagerStatus = createManagerStatus({
  backend: "qmd",
  provider: "qmd",
  model: "qmd",
  requestedProvider: "qmd",
  withMemorySourceCounts: true,
});

const mockPrimary = {
  search: vi.fn(async () => []),
  readFile: vi.fn(async () => ({ text: "", path: "MEMORY.md" })),
  status: vi.fn(() => qmdManagerStatus),
  sync: vi.fn(async () => {}),
  probeEmbeddingAvailability: vi.fn(async () => ({ ok: true })),
  probeVectorAvailability: vi.fn(async () => true),
  close: vi.fn(async () => {}),
};

const mockMemoryIndexGet = vi.fn();

vi.mock("./qmd-manager.js", () => ({
  QmdMemoryManager: {
    create: vi.fn(async () => mockPrimary),
  },
}));

vi.mock("./manager.js", () => ({
  MemoryIndexManager: {
    get: mockMemoryIndexGet,
  },
}));

import { QmdMemoryManager } from "./qmd-manager.js";
import { getMemorySearchManager } from "./search-manager.js";
// eslint-disable-next-line @typescript-eslint/unbound-method -- mocked static function
const createQmdManagerMock = vi.mocked(QmdMemoryManager.create);

type SearchManagerResult = Awaited<ReturnType<typeof getMemorySearchManager>>;

function createQmdCfg(agentId: string): OpenClawConfig {
  return {
    memory: { backend: "qmd", qmd: {} },
    agents: { list: [{ id: agentId, default: true, workspace: "/tmp/workspace" }] },
  };
}

function requireManager(result: SearchManagerResult): NonNullable<SearchManagerResult["manager"]> {
  expect(result.manager).toBeTruthy();
  if (!result.manager) {
    throw new Error("manager missing");
  }
  return result.manager;
}

beforeEach(() => {
  mockPrimary.search.mockClear();
  mockPrimary.readFile.mockClear();
  mockPrimary.status.mockClear();
  mockPrimary.sync.mockClear();
  mockPrimary.probeEmbeddingAvailability.mockClear();
  mockPrimary.probeVectorAvailability.mockClear();
  mockPrimary.close.mockClear();
  mockMemoryIndexGet.mockClear();
  createQmdManagerMock.mockClear();
  createQmdManagerMock.mockResolvedValue(mockPrimary as unknown as QmdMemoryManager);
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
});

describe("getMemorySearchManager QMD behavior", () => {
  it("returns manager when QMD is configured and succeeds", async () => {
    const cfg = createQmdCfg("success-agent");

    const result = await getMemorySearchManager({ cfg, agentId: "success-agent" });

    expect(result.manager).toBeTruthy();
    expect(result.error).toBeUndefined();
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(createQmdManagerMock).toHaveBeenCalledTimes(1);
  });

  it("returns null manager with error when QMD throws", async () => {
    const cfg = createQmdCfg("error-agent");
    createQmdManagerMock.mockRejectedValueOnce(new Error("qmd not found in PATH"));

    const result = await getMemorySearchManager({ cfg, agentId: "error-agent" });

    expect(result.manager).toBeNull();
    expect(result.error).toContain("QMD backend error");
    expect(result.error).toContain("qmd not found in PATH");
    // Should not fall back to builtin
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(mockMemoryIndexGet).not.toHaveBeenCalled();
  });

  it("returns null manager with error when QMD returns null", async () => {
    const cfg = createQmdCfg("null-agent");
    createQmdManagerMock.mockResolvedValueOnce(null as unknown as QmdMemoryManager);

    const result = await getMemorySearchManager({ cfg, agentId: "null-agent" });

    expect(result.manager).toBeNull();
    expect(result.error).toContain("QMD backend returned null");
    // Should not fall back to builtin
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(mockMemoryIndexGet).not.toHaveBeenCalled();
  });
});

describe("getMemorySearchManager builtin fallback", () => {
  it("uses builtin manager when memory.backend is not set to qmd", async () => {
    const cfg: OpenClawConfig = {
      memory: { backend: "builtin" },
      agents: { list: [{ id: "builtin-agent", default: true, workspace: "/tmp/workspace" }] },
    };
    const fallbackManager = {
      search: vi.fn(async () => []),
      readFile: vi.fn(async () => ({ text: "", path: "MEMORY.md" })),
      status: vi.fn(() => qmdManagerStatus),
      sync: vi.fn(async () => {}),
      probeEmbeddingAvailability: vi.fn(async () => ({ ok: true })),
      probeVectorAvailability: vi.fn(async () => true),
      close: vi.fn(async () => {}),
    };
    mockMemoryIndexGet.mockResolvedValueOnce(fallbackManager);

    const result = await getMemorySearchManager({ cfg, agentId: "builtin-agent" });

    expect(result.manager).toBe(fallbackManager);
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(mockMemoryIndexGet).toHaveBeenCalledTimes(1);
    // Should not try to create QMD manager
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(createQmdManagerMock).not.toHaveBeenCalled();
  });
});
