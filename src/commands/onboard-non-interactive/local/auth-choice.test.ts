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
});
