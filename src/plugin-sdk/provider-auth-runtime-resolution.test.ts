import fs from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import type { Model } from "../llm/types.js";
import * as authRuntime from "./provider-auth-runtime.js";

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

it("retains canonical credential owners through the native auth facade", async () => {
  const [store, order, oauth, fence] = await Promise.all([
    import("../agents/auth-profiles/store-runtime.js"),
    import("../agents/auth-profiles/order.js"),
    import("../agents/auth-profiles/oauth.js"),
    import("../agents/auth-profiles/oauth-refresh-marker.js"),
  ]);
  expect(authRuntime.ensureAuthProfileStoreAsync).toBe(store.ensureAuthProfileStoreAsync);
  expect(authRuntime.findPersistedAuthProfileCredentialAsync).toBe(
    store.findPersistedAuthProfileCredentialAsync,
  );
  expect(authRuntime.resolvePersistedAuthProfileOwnerAgentDirAsync).toBe(
    store.resolvePersistedAuthProfileOwnerAgentDirAsync,
  );
  expect(authRuntime.resolveAuthProfileOrder).toBe(order.resolveAuthProfileOrder);
  expect(authRuntime.refreshOAuthCredentialForRuntime).toBe(oauth.refreshOAuthCredentialForRuntime);
  expect(authRuntime.resolveApiKeyForProfile).toBe(oauth.resolveApiKeyForProfile);
  expect(authRuntime.isPendingOAuthRefreshFence).toBe(fence.isPendingOAuthRefreshFence);
  expect(authRuntime.isSameOAuthRefreshGeneration).toBe(fence.isSameOAuthRefreshGeneration);
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

  await expect(authRuntime.resolveApiKeyForProvider(provider)).resolves.toBe(credential);
  await expect(authRuntime.getRuntimeAuthForModel(request)).resolves.toBe(credential);
  expect(runtime.provider).toHaveBeenCalledWith(provider);
  expect(runtime.model).toHaveBeenCalledWith(request);
});
