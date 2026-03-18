import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../../config/config.js";
import { applyNonInteractiveAuthChoice } from "./auth-choice.js";

const applySimpleNonInteractiveApiKeyChoice = vi.hoisted(() =>
  vi.fn<() => Promise<OpenClawConfig | null | undefined>>(async () => undefined),
);
vi.mock("./auth-choice.api-key-providers.js", () => ({
  applySimpleNonInteractiveApiKeyChoice,
}));

const applyNonInteractivePluginProviderChoice = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("./auth-choice.plugin-providers.js", () => ({
  applyNonInteractivePluginProviderChoice,
}));

const resolveNonInteractiveApiKey = vi.hoisted(() => vi.fn());
vi.mock("../api-keys.js", () => ({
  resolveNonInteractiveApiKey,
}));

beforeEach(() => {
  vi.clearAllMocks();
});

function createRuntime() {
  return {
    error: vi.fn(),
    exit: vi.fn(),
    log: vi.fn(),
  };
}

describe("applyNonInteractiveAuthChoice", () => {
  it("resolves plugin provider auth before builtin API key fallbacks", async () => {
    const runtime = createRuntime();
    const nextConfig = { agents: { defaults: {} } } as OpenClawConfig;
    const resolvedConfig = { auth: { profiles: { "openai:default": { mode: "api_key" } } } };
    applyNonInteractivePluginProviderChoice.mockResolvedValueOnce(resolvedConfig as never);

    const result = await applyNonInteractiveAuthChoice({
      nextConfig,
      authChoice: "openai-api-key",
      opts: {} as never,
      runtime: runtime as never,
      baseConfig: nextConfig,
    });

    expect(result).toBe(resolvedConfig);
    expect(applyNonInteractivePluginProviderChoice).toHaveBeenCalledOnce();
    expect(applySimpleNonInteractiveApiKeyChoice).not.toHaveBeenCalled();
  });

  it("applies azure-openai-api-key non-interactively with explicit Azure flags", async () => {
    const runtime = createRuntime();
    const nextConfig = { agents: { defaults: {} } } as OpenClawConfig;
    resolveNonInteractiveApiKey.mockResolvedValueOnce({
      key: "azure-test-key",
      source: "flag",
    });

    const result = await applyNonInteractiveAuthChoice({
      nextConfig,
      authChoice: "azure-openai-api-key",
      opts: {
        azureOpenaiApiKey: "azure-test-key",
        azureOpenaiBaseUrl: "https://example.openai.azure.com/openai/v1",
        azureOpenaiModelId: "gpt-4.1",
      },
      runtime: runtime as never,
      baseConfig: nextConfig,
    });

    expect(result?.auth?.profiles?.["azure-openai-responses:default"]).toMatchObject({
      provider: "azure-openai-responses",
      mode: "api_key",
    });
    const defaultsWithModel = result?.agents?.defaults as
      | { model?: { primary?: string } }
      | undefined;
    expect(defaultsWithModel?.model?.primary).toBe("azure-openai-responses/gpt-4.1");
    expect(applySimpleNonInteractiveApiKeyChoice).toHaveBeenCalledOnce();
    expect(runtime.exit).not.toHaveBeenCalled();
  });
});
