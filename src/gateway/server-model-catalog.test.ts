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
    {
      id: "glm-4.6",
      name: "GLM 4.6",
      provider: "z.ai",
      contextWindow: 128_000,
    },
    {
      id: "qwen3-max",
      name: "Qwen3 Max",
      provider: "modelstudio",
      contextWindow: 256_000,
    },
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

    expect(catalog).toHaveLength(5);
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

  it("stores aliased providers under the normalized qualified key", async () => {
    const { loadGatewayModelCatalog } = await import("./server-model-catalog.js");

    await loadGatewayModelCatalog();

    // "z.ai" normalizes to "zai"; the raw alias should not be used as the key.
    expect(MODEL_CONTEXT_TOKEN_CACHE.get("zai/glm-4.6")).toBe(128_000);
    expect(MODEL_CONTEXT_TOKEN_CACHE.has("z.ai/glm-4.6")).toBe(false);
    // "modelstudio" normalizes to "qwen".
    expect(MODEL_CONTEXT_TOKEN_CACHE.get("qwen/qwen3-max")).toBe(256_000);
    expect(MODEL_CONTEXT_TOKEN_CACHE.has("modelstudio/qwen3-max")).toBe(false);
  });
});
