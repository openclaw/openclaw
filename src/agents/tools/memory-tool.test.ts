import { beforeEach, describe, it, vi } from "vitest";
import {
  resetMemoryToolMockState,
  setMemorySearchImpl,
} from "../../../test/helpers/memory-tool-manager-mock.js";
import {
  createMemorySearchToolOrThrow,
  expectUnavailableMemorySearchDetails,
} from "./memory-tool.test-helpers.js";

describe("memory_search unavailable payloads", () => {
  beforeEach(() => {
    resetMemoryToolMockState({ searchImpl: async () => [] });
  });

  it("returns explicit unavailable metadata for quota failures", async () => {
    setMemorySearchImpl(async () => {
      throw new Error("openai embeddings failed: 429 insufficient_quota");
    });

    const tool = createMemorySearchToolOrThrow();
    const result = await tool.execute("quota", { query: "hello" });
    expectUnavailableMemorySearchDetails(result.details, {
      error: "openai embeddings failed: 429 insufficient_quota",
      warning: "Memory search is unavailable because the embedding provider quota is exhausted.",
      action: "Top up or switch embedding provider, then retry memory_search.",
    });
  });

  it("returns explicit unavailable metadata for non-quota failures", async () => {
    setMemorySearchImpl(async () => {
      throw new Error("embedding provider timeout");
    });

    const tool = createMemorySearchToolOrThrow();
    const result = await tool.execute("generic", { query: "hello" });
    expectUnavailableMemorySearchDetails(result.details, {
      error: "embedding provider timeout",
      warning: "Memory search is unavailable due to an embedding/provider error.",
      action: "Check embedding provider configuration and retry memory_search.",
    });
  });

  it("returns unavailable result when search stalls past the timeout", async () => {
    vi.useFakeTimers();
    try {
      setMemorySearchImpl(() => new Promise(() => {})); // never resolves

      const tool = createMemorySearchToolOrThrow();
      const resultPromise = tool.execute("stall", { query: "hello" });

      // Advance past the 30s timeout
      await vi.advanceTimersByTimeAsync(31_000);

      const result = await resultPromise;
      expectUnavailableMemorySearchDetails(result.details, {
        error: "memory_search timed out",
        warning: "Memory search timed out.",
        action: "Retry memory_search. If this persists, check embedding provider latency.",
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
