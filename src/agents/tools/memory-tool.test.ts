import { beforeEach, describe, it } from "vitest";
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

  it("returns model-not-found guidance for 404 errors", async () => {
    setMemorySearchImpl(async () => {
      throw new Error("Ollama embeddings HTTP 404: model 'all-minilm' not found");
    });

    const tool = createMemorySearchToolOrThrow();
    const result = await tool.execute("notfound", { query: "hello" });
    expectUnavailableMemorySearchDetails(result.details, {
      error: "Ollama embeddings HTTP 404: model 'all-minilm' not found",
      warning:
        "Memory search is unavailable because the embedding model was not found (404). The model may need to be pulled or the model name may be incorrect.",
      action:
        "Pull the model (e.g. `ollama pull <model>`) or update `agents.defaults.memorySearch.model` in config, then retry memory_search.",
    });
  });
});
