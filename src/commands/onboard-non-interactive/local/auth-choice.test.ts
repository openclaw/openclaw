import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../../config/config.js";
import { applyNonInteractiveAuthChoice } from "./auth-choice.js";

const applyNonInteractivePluginProviderChoice = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("./auth-choice.plugin-providers.js", () => ({
  applyNonInteractivePluginProviderChoice,
}));

const resolveNonInteractiveApiKey = vi.hoisted(() => vi.fn());
vi.mock("../api-keys.js", () => ({
  resolveNonInteractiveApiKey,
}));

const resolveManifestDeprecatedProviderAuthChoice = vi.hoisted(() => vi.fn(() => undefined));
const resolveManifestProviderAuthChoices = vi.hoisted(() => vi.fn(() => []));
vi.mock("../../../plugins/provider-auth-choices.js", () => ({
  resolveManifestDeprecatedProviderAuthChoice,
  resolveManifestProviderAuthChoices,
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
  it("resolves plugin provider auth before builtin custom-provider handling", async () => {
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
  });

  it("fails with manifest-owned replacement guidance for deprecated auth choices", async () => {
    const runtime = createRuntime();
    const nextConfig = { agents: { defaults: {} } } as OpenClawConfig;
    resolveManifestDeprecatedProviderAuthChoice.mockReturnValueOnce({
      choiceId: "minimax-global-api",
    } as never);

    const result = await applyNonInteractiveAuthChoice({
      nextConfig,
      authChoice: "minimax",
      opts: {} as never,
      runtime: runtime as never,
      baseConfig: nextConfig,
    });

    expect(result).toBeNull();
    expect(runtime.error).toHaveBeenCalledWith(
      '"minimax" is no longer supported. Use --auth-choice minimax-global-api instead.',
    );
    expect(runtime.exit).toHaveBeenCalledWith(1);
    expect(applyNonInteractivePluginProviderChoice).toHaveBeenCalledOnce();
  });
});
