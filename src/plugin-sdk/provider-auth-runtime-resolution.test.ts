import fs from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import type { Model } from "../llm/types.js";
import { getRuntimeAuthForModel, resolveApiKeyForProvider } from "./provider-auth-runtime.js";

const runtime = vi.hoisted(() => ({
  provider:
    vi.fn<
      typeof import("../plugins/runtime/runtime-model-auth.runtime.js").resolveProviderRuntimeApiKey
    >(),
  model:
    vi.fn<
      typeof import("../plugins/runtime/runtime-model-auth.runtime.js").getRuntimeAuthForModelCore
    >(),
}));

// mock-isolation: Keep credential lookup and provider initialization outside this resolution fixture.
vi.mock("../plugins/runtime/runtime-model-auth.runtime.js", () => ({
  resolveProviderRuntimeApiKey: runtime.provider,
  getRuntimeAuthForModelCore: runtime.model,
}));

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

it("resolves provider and model auth when runtime code has no physical file", async () => {
  vi.spyOn(fs, "existsSync").mockReturnValue(false);
  const credential = { apiKey: "test-key", source: "test", mode: "api-key" } as const;
  runtime.provider.mockResolvedValue(credential);
  runtime.model.mockResolvedValue(credential);
  const provider = { provider: "test-provider" };
  const model: Model = {
    id: "test-model",
    name: "Test model",
    provider: "test-provider",
    api: "openai-responses",
    baseUrl: "https://provider.example/v1",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    maxTokens: 100,
  };
  const request = { model };

  await expect(resolveApiKeyForProvider(provider)).resolves.toBe(credential);
  await expect(getRuntimeAuthForModel(request)).resolves.toBe(credential);
  expect(runtime.provider).toHaveBeenCalledWith(provider);
  expect(runtime.model).toHaveBeenCalledWith(request);
});
