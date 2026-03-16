import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../../config/config.js";
import { applyNonInteractivePluginProviderChoice } from "./auth-choice.plugin-providers.js";

const resolvePreferredProviderForAuthChoice = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("../../auth-choice.preferred-provider.js", () => ({
  resolvePreferredProviderForAuthChoice,
}));

const resolveOwningPluginIdsForProvider = vi.hoisted(() => vi.fn(() => undefined));
const resolveProviderPluginChoice = vi.hoisted(() => vi.fn());
const resolvePluginProviders = vi.hoisted(() => vi.fn(() => []));
vi.mock("./auth-choice.plugin-providers.runtime.js", () => ({
  resolveOwningPluginIdsForProvider,
  resolveProviderPluginChoice,
  resolvePluginProviders,
  PROVIDER_PLUGIN_CHOICE_PREFIX: "provider-plugin:",
}));

beforeEach(() => {
  vi.clearAllMocks();
});

function createRuntime() {
  return {
    error: vi.fn(),
    exit: vi.fn(),
  };
}

describe("applyNonInteractivePluginProviderChoice", () => {
  it("loads plugin providers for provider-plugin auth choices", async () => {
    const runtime = createRuntime();
    const runNonInteractive = vi.fn(async () => ({ plugins: { allow: ["vllm"] } }));
    resolveOwningPluginIdsForProvider.mockReturnValue(["vllm"] as never);
    resolvePluginProviders.mockReturnValue([{ id: "vllm", pluginId: "vllm" }] as never);
    resolveProviderPluginChoice.mockReturnValue({
      provider: { id: "vllm", pluginId: "vllm", label: "vLLM" },
      method: { runNonInteractive },
    });

    const result = await applyNonInteractivePluginProviderChoice({
      nextConfig: { agents: { defaults: {} } } as OpenClawConfig,
      authChoice: "provider-plugin:vllm:custom",
      opts: {} as never,
      runtime: runtime as never,
      baseConfig: { agents: { defaults: {} } } as OpenClawConfig,
      resolveApiKey: vi.fn(),
      toApiKeyCredential: vi.fn(),
    });

    expect(resolveOwningPluginIdsForProvider).toHaveBeenCalledOnce();
    expect(resolveOwningPluginIdsForProvider).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "vllm",
      }),
    );
    expect(resolvePluginProviders).toHaveBeenCalledOnce();
    expect(resolvePluginProviders).toHaveBeenCalledWith(
      expect.objectContaining({
        onlyPluginIds: ["vllm"],
      }),
    );
    expect(resolveProviderPluginChoice).toHaveBeenCalledOnce();
    expect(runNonInteractive).toHaveBeenCalledOnce();
    expect(result).toEqual({ plugins: { allow: ["vllm"] } });
  });
});
