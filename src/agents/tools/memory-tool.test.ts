import { beforeEach, describe, expect, it, vi } from "vitest";

type SearchImpl = () => Promise<unknown[]>;
let searchImpl: SearchImpl = async () => [];

const stubManager = {
  search: vi.fn(async () => await searchImpl()),
  readFile: vi.fn(),
  status: () => ({
    backend: "builtin" as const,
    files: 1,
    chunks: 1,
    dirty: false,
    workspaceDir: "/workspace",
    dbPath: "/workspace/.memory/index.sqlite",
    provider: "builtin",
    model: "builtin",
    requestedProvider: "builtin",
    sources: ["memory" as const],
    sourceCounts: [{ source: "memory" as const, files: 1, chunks: 1 }],
  }),
  sync: vi.fn(),
  probeVectorAvailability: vi.fn(async () => true),
  close: vi.fn(),
};

vi.mock("../../memory/index.js", () => ({
  getMemorySearchManager: async () => ({ manager: stubManager }),
}));

import { createMemorySearchTool } from "./memory-tool.js";

describe("memory_search unavailable payloads", () => {
  beforeEach(() => {
    searchImpl = async () => [];
    vi.clearAllMocks();
  });

  it("returns explicit unavailable metadata for quota failures", async () => {
    searchImpl = async () => {
      throw new Error("openai embeddings failed: 429 insufficient_quota");
    };

    const tool = createMemorySearchTool({
      config: { agents: { list: [{ id: "main", default: true }] } },
    });
    if (!tool) {
      throw new Error("tool missing");
    }

    const result = await tool.execute("quota", { query: "hello" });
    expect(result.details).toEqual({
      results: [],
      disabled: true,
      unavailable: true,
      error: "openai embeddings failed: 429 insufficient_quota",
      warning: "Memory search is unavailable because the embedding provider quota is exhausted.",
      action: "Top up or switch embedding provider, then retry memory_search.",
    });
  });

  it("returns explicit unavailable metadata for non-quota failures", async () => {
    searchImpl = async () => {
      throw new Error("embedding provider timeout");
    };

    const tool = createMemorySearchTool({
      config: { agents: { list: [{ id: "main", default: true }] } },
    });
    if (!tool) {
      throw new Error("tool missing");
    }

    const result = await tool.execute("generic", { query: "hello" });
    expect(result.details).toEqual({
      results: [],
      disabled: true,
      unavailable: true,
      error: "embedding provider timeout",
      warning: "Memory search is unavailable due to an embedding/provider error.",
      action: "Check embedding provider configuration and retry memory_search.",
    });
  });
});
