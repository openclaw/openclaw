import { describe, it, expect, vi, beforeEach } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import type { MemorySearchManager } from "../../memory/types.js";

// Mock the memory manager module
vi.mock("../../memory/index.js", () => ({
  getMemorySearchManager: vi.fn(),
}));

// Mock agent scope + memory-search resolution
vi.mock("../../agents/agent-scope.js", () => ({
  resolveSessionAgentId: vi.fn(() => "main"),
}));

vi.mock("../../agents/memory-search.js", () => ({
  resolveMemorySearchConfig: vi.fn(),
}));

import { resolveMemorySearchConfig } from "../../agents/memory-search.js";
import { getMemorySearchManager } from "../../memory/index.js";
import { runMemoryPrefetch } from "./memory-prefetch.js";

const mockGetManager = vi.mocked(getMemorySearchManager);
const mockResolveConfig = vi.mocked(resolveMemorySearchConfig);

const baseCfg = {} as OpenClawConfig;
const baseParams = {
  message: "What did we decide about the database schema?",
  sessionKey: "main",
  cfg: baseCfg,
};

function makeResolvedCfg(overrides: Partial<ReturnType<typeof resolveMemorySearchConfig>> = {}) {
  return {
    enabled: true,
    query: { minScore: 0.2, maxResults: 6 },
    autoPrefetch: {
      enabled: true,
      minMessageLength: 20,
      maxResults: 3,
      skipPatterns: [],
    },
    ...overrides,
  } as ReturnType<typeof resolveMemorySearchConfig>;
}

function makeManager(
  results: Awaited<ReturnType<MemorySearchManager["search"]>>,
): MemorySearchManager {
  return {
    search: vi.fn().mockResolvedValue(results),
    readFile: vi.fn(),
    status: vi.fn().mockReturnValue({ backend: "builtin", provider: "local" }),
    probeEmbeddingAvailability: vi.fn().mockResolvedValue({ ok: true }),
    probeVectorAvailability: vi.fn().mockResolvedValue(true),
  };
}

describe("runMemoryPrefetch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns null context when autoPrefetch disabled", async () => {
    mockResolveConfig.mockReturnValue(
      makeResolvedCfg({
        autoPrefetch: {
          enabled: false,
          minMessageLength: 20,
          maxResults: 3,
          skipPatterns: [],
        },
      }),
    );
    const result = await runMemoryPrefetch(baseParams);
    expect(result.context).toBeNull();
    expect(mockGetManager).not.toHaveBeenCalled();
  });

  it("returns null context when memorySearch config is null (disabled)", async () => {
    mockResolveConfig.mockReturnValue(null);
    const result = await runMemoryPrefetch(baseParams);
    expect(result.context).toBeNull();
  });

  it("returns null context when message is shorter than minMessageLength", async () => {
    mockResolveConfig.mockReturnValue(makeResolvedCfg());
    const result = await runMemoryPrefetch({ ...baseParams, message: "Hi" });
    expect(result.context).toBeNull();
    expect(mockGetManager).not.toHaveBeenCalled();
  });

  it("returns null context when message matches a skip pattern", async () => {
    mockResolveConfig.mockReturnValue(
      makeResolvedCfg({
        autoPrefetch: {
          enabled: true,
          minMessageLength: 5,
          maxResults: 3,
          skipPatterns: ["HEARTBEAT_OK", "heartbeat"],
        },
      }),
    );
    const result = await runMemoryPrefetch({ ...baseParams, message: "HEARTBEAT_OK ping check" });
    expect(result.context).toBeNull();
  });

  it("returns null context when manager is unavailable", async () => {
    mockResolveConfig.mockReturnValue(makeResolvedCfg());
    mockGetManager.mockResolvedValue({ manager: null, error: "not configured" });
    const result = await runMemoryPrefetch(baseParams);
    expect(result.context).toBeNull();
  });

  it("returns null context when search returns no results", async () => {
    mockResolveConfig.mockReturnValue(makeResolvedCfg());
    const manager = makeManager([]);
    mockGetManager.mockResolvedValue({ manager });
    const result = await runMemoryPrefetch(baseParams);
    expect(result.context).toBeNull();
  });

  it("formats memory context block for non-empty results", async () => {
    mockResolveConfig.mockReturnValue(makeResolvedCfg());
    const manager = makeManager([
      {
        path: "memory/db.md",
        startLine: 5,
        endLine: 10,
        score: 0.8,
        snippet: "We use PostgreSQL.",
        source: "memory",
      },
      {
        path: "memory/arch.md",
        startLine: 1,
        endLine: 1,
        score: 0.7,
        snippet: "Single DB node.",
        source: "memory",
      },
    ]);
    mockGetManager.mockResolvedValue({ manager });
    const result = await runMemoryPrefetch(baseParams);
    expect(result.context).toContain("## Memory context");
    expect(result.context).toContain("[memory/db.md#L5-L10]");
    expect(result.context).toContain("We use PostgreSQL.");
    expect(result.context).toContain("[memory/arch.md#L1]");
    expect(result.context).toContain("Single DB node.");
  });

  it("passes maxResults from config to manager.search", async () => {
    mockResolveConfig.mockReturnValue(
      makeResolvedCfg({
        autoPrefetch: {
          enabled: true,
          minMessageLength: 10,
          maxResults: 2,
          skipPatterns: [],
        },
      }),
    );
    const manager = makeManager([]);
    mockGetManager.mockResolvedValue({ manager });
    await runMemoryPrefetch(baseParams);
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(manager.search).toHaveBeenCalledWith(
      baseParams.message,
      expect.objectContaining({ maxResults: 2 }),
    );
  });

  it("gracefully handles search errors without throwing", async () => {
    mockResolveConfig.mockReturnValue(makeResolvedCfg());
    const manager = makeManager([]);
    // eslint-disable-next-line @typescript-eslint/unbound-method
    vi.mocked(manager.search).mockRejectedValue(new Error("DB locked"));
    mockGetManager.mockResolvedValue({ manager });
    const result = await runMemoryPrefetch(baseParams);
    expect(result.context).toBeNull();
  });

  it("ignores invalid skip pattern regexes", async () => {
    mockResolveConfig.mockReturnValue(
      makeResolvedCfg({
        autoPrefetch: {
          enabled: true,
          minMessageLength: 5,
          maxResults: 3,
          skipPatterns: ["[invalid-regex"],
        },
      }),
    );
    const manager = makeManager([
      {
        path: "memory/x.md",
        startLine: 1,
        endLine: 1,
        score: 0.8,
        snippet: "some info",
        source: "memory",
      },
    ]);
    mockGetManager.mockResolvedValue({ manager });
    // Should not throw; invalid regex is silently skipped
    const result = await runMemoryPrefetch({ ...baseParams, message: "What is the plan here?" });
    expect(result.context).toContain("## Memory context");
  });
});
