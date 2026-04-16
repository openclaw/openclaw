import { afterEach, describe, expect, it, vi } from "vitest";
import { MODEL_CONTEXT_TOKEN_CACHE } from "../agents/context-cache.js";

vi.mock("../agents/model-catalog.js", () => ({
  loadModelCatalog: vi.fn().mockResolvedValue([
    {
      id: "claude-sonnet-4-6",
      name: "Claude Sonnet 4.6",
      provider: "anthropic",
      contextWindow: 200_000,
    },
    { id: "gpt-5", name: "GPT-5", provider: "openai", contextWindow: 128_000 },
    { id: "no-window-model", name: "No Window", provider: "test" },
  ]),
  resetModelCatalogCacheForTest: vi.fn(),
}));

vi.mock("../config/config.js", () => ({
  getRuntimeConfig: vi.fn().mockReturnValue({}),
}));

describe("loadGatewayModelCatalog", () => {
  afterEach(() => {
    MODEL_CONTEXT_TOKEN_CACHE.clear();
  });

  it("populates the context window cache with bare and provider-qualified keys", async () => {
    const { loadGatewayModelCatalog } = await import("./server-model-catalog.js");

    const catalog = await loadGatewayModelCatalog();

    expect(catalog).toHaveLength(3);
    // Bare keys
    expect(MODEL_CONTEXT_TOKEN_CACHE.get("claude-sonnet-4-6")).toBe(200_000);
    expect(MODEL_CONTEXT_TOKEN_CACHE.get("gpt-5")).toBe(128_000);
    // Provider-qualified keys
    expect(MODEL_CONTEXT_TOKEN_CACHE.get("anthropic/claude-sonnet-4-6")).toBe(200_000);
    expect(MODEL_CONTEXT_TOKEN_CACHE.get("openai/gpt-5")).toBe(128_000);
    // Models without contextWindow should not be in cache
    expect(MODEL_CONTEXT_TOKEN_CACHE.has("no-window-model")).toBe(false);
    expect(MODEL_CONTEXT_TOKEN_CACHE.has("test/no-window-model")).toBe(false);
  });
});
