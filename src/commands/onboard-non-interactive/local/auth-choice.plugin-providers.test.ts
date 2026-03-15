import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../../config/config.js";
import { applyNonInteractivePluginProviderChoice } from "./auth-choice.plugin-providers.js";

const resolvePreferredProviderForAuthChoice = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("../../auth-choice.preferred-provider.js", () => ({
  resolvePreferredProviderForAuthChoice,
}));

const resolveProviderPluginChoice = vi.hoisted(() => vi.fn());
const resolvePluginProviders = vi.hoisted(() => vi.fn(() => []));
vi.mock("./auth-choice.plugin-providers.runtime.js", () => ({
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

    expect(resolvePluginProviders).toHaveBeenCalledOnce();
    expect(resolveProviderPluginChoice).toHaveBeenCalledOnce();
    expect(runNonInteractive).toHaveBeenCalledOnce();
    expect(result).toEqual({ plugins: { allow: ["vllm"] } });
  });
});
