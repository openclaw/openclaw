import { beforeEach, describe, expect, it } from "vitest";
import {
  resetMemoryToolMockState,
  setMemorySearchImpl,
} from "../../../test/helpers/memory-tool-manager-mock.js";
import { createMemorySearchTool } from "./memory-tool.js";

describe("memory_search unavailable payloads", () => {
  beforeEach(() => {
    resetMemoryToolMockState({ searchImpl: async () => [] });
  });

  it("returns explicit unavailable metadata for quota failures", async () => {
    setMemorySearchImpl(async () => {
      throw new Error("openai embeddings failed: 429 insufficient_quota");
    });

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
    setMemorySearchImpl(async () => {
      throw new Error("embedding provider timeout");
    });

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
