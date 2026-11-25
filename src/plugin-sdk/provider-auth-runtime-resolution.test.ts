import fs from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import type { Model } from "../llm/types.js";
import { getRuntimeAuthForModel, resolveApiKeyForProvider } from "./provider-auth-runtime.js";

const runtime = vi.hoisted(() => ({
  loaded: vi.fn(),
  provider: vi.fn<typeof import("../agents/model-auth-provider.js").resolveApiKeyForProviderCore>(),
  model:
    vi.fn<
      typeof import("../plugins/runtime/runtime-model-auth.runtime.js").getRuntimeAuthForModelCore
    >(),
}));

// mock-isolation: Keep credential lookup and provider initialization outside this resolution fixture.
vi.mock("../agents/model-auth-provider.js", () => ({
  resolveApiKeyForProviderCore: runtime.provider,
}));
// mock-isolation: Observe lazy model-runtime initialization without loading real provider state.
vi.mock("../plugins/runtime/runtime-model-auth.runtime.js", () => {
  runtime.loaded();
  return {
    resolveProviderRuntimeApiKey: runtime.provider,
    getRuntimeAuthForModelCore: runtime.model,
  };
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

it("keeps provider auth independent of model-runtime initialization without physical files", async () => {
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
  expect(runtime.loaded).not.toHaveBeenCalled();
  await expect(getRuntimeAuthForModel(request)).resolves.toBe(credential);
  expect(runtime.loaded).toHaveBeenCalledOnce();
  expect(runtime.provider).toHaveBeenCalledWith(provider);
  expect(runtime.model).toHaveBeenCalledWith(request);
});

it.each(["before lookup", "while awaiting import"])("preserves cancellation %s", async (phase) => {
  const controller = new AbortController();
  const reason = new Error("provider lookup cancelled");
  if (phase === "before lookup") {
    controller.abort(reason);
  }
  const lookup = resolveApiKeyForProvider({
    provider: "test-provider",
    signal: controller.signal,
  });
  controller.abort(reason);
  await expect(lookup).rejects.toBe(reason);
  expect(runtime.provider).not.toHaveBeenCalled();
});
