import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../../config/config.js";
import { applySimpleNonInteractiveApiKeyChoice } from "./auth-choice.api-key-providers.js";

const applyAuthProfileConfig = vi.hoisted(() => vi.fn((cfg: OpenClawConfig) => cfg));
vi.mock("../../../plugins/provider-auth-helpers.js", () => ({
  applyAuthProfileConfig,
}));

const setGigachatApiKey = vi.hoisted(() => vi.fn(async () => {}));
const setLitellmApiKey = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("../../../plugins/provider-auth-storage.js", () => ({
  setGigachatApiKey,
  setLitellmApiKey,
}));

const applyGigachatConfig = vi.hoisted(() => vi.fn((cfg: OpenClawConfig) => cfg));
vi.mock("../../onboard-auth.config-core.js", () => ({
  applyGigachatConfig,
}));

const applyLitellmConfig = vi.hoisted(() => vi.fn((cfg: OpenClawConfig) => cfg));
vi.mock("../../onboard-auth.config-litellm.js", () => ({
  applyLitellmConfig,
}));

describe("applySimpleNonInteractiveApiKeyChoice", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    applyAuthProfileConfig.mockImplementation((cfg: OpenClawConfig) => cfg);
    applyGigachatConfig.mockImplementation((cfg: OpenClawConfig) => cfg);
    applyLitellmConfig.mockImplementation((cfg: OpenClawConfig) => cfg);
  });

  it("disables profile fallback for GigaChat personal OAuth onboarding", async () => {
    const nextConfig = { agents: { defaults: {} } } as OpenClawConfig;
    const resolveApiKey = vi.fn(async () => ({
      key: "gigachat-oauth-credentials",
      source: "env" as const,
    }));
    const maybeSetResolvedApiKey = vi.fn(async (resolved, setter) => {
      await setter(resolved.key);
      return true;
    });

    await applySimpleNonInteractiveApiKeyChoice({
      authChoice: "gigachat-api-key",
      nextConfig,
      baseConfig: nextConfig,
      opts: {} as never,
      runtime: { error: vi.fn(), exit: vi.fn(), log: vi.fn() } as never,
      apiKeyStorageOptions: undefined,
      resolveApiKey,
      maybeSetResolvedApiKey,
    });

    expect(resolveApiKey).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "gigachat",
        flagName: "--gigachat-api-key",
        envVar: "GIGACHAT_CREDENTIALS",
        allowProfile: false,
      }),
    );
    expect(maybeSetResolvedApiKey).toHaveBeenCalledOnce();
    expect(setGigachatApiKey).toHaveBeenCalledWith(
      "gigachat-oauth-credentials",
      undefined,
      undefined,
      {
        authMode: "oauth",
        insecureTls: "false",
        scope: "GIGACHAT_API_PERS",
      },
    );
  });

  it("accepts the generic --token input for GigaChat non-interactive OAuth", async () => {
    const nextConfig = { agents: { defaults: {} } } as OpenClawConfig;
    const resolveApiKey = vi.fn(async () => ({
      key: "gigachat-token-credentials",
      source: "flag" as const,
    }));
    const maybeSetResolvedApiKey = vi.fn(async (resolved, setter) => {
      await setter(resolved.key);
      return true;
    });

    await applySimpleNonInteractiveApiKeyChoice({
      authChoice: "gigachat-oauth",
      nextConfig,
      baseConfig: nextConfig,
      opts: { token: "gigachat-token-credentials" } as never,
      runtime: { error: vi.fn(), exit: vi.fn(), log: vi.fn() } as never,
      apiKeyStorageOptions: undefined,
      resolveApiKey,
      maybeSetResolvedApiKey,
    });

    expect(resolveApiKey).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "gigachat",
        flagValue: "gigachat-token-credentials",
        flagName: "--gigachat-api-key",
        envVar: "GIGACHAT_CREDENTIALS",
        allowProfile: false,
      }),
    );
    expect(setGigachatApiKey).toHaveBeenCalledWith(
      "gigachat-token-credentials",
      undefined,
      undefined,
      {
        authMode: "oauth",
        insecureTls: "false",
        scope: "GIGACHAT_API_PERS",
      },
    );
  });

  it("rejects Basic-shaped GIGACHAT_CREDENTIALS in the OAuth onboarding path", async () => {
    const nextConfig = { agents: { defaults: {} } } as OpenClawConfig;
    const runtime = {
      error: vi.fn(),
      exit: vi.fn(),
      log: vi.fn(),
    } as never;
    const resolveApiKey = vi.fn(async () => ({
      key: "basic-user:basic-pass",
      source: "env" as const,
    }));
    const maybeSetResolvedApiKey = vi.fn();

    const result = await applySimpleNonInteractiveApiKeyChoice({
      authChoice: "gigachat-api-key",
      nextConfig,
      baseConfig: nextConfig,
      opts: {} as never,
      runtime,
      apiKeyStorageOptions: undefined,
      resolveApiKey,
      maybeSetResolvedApiKey,
    });

    expect(result).toBeNull();
    expect(maybeSetResolvedApiKey).not.toHaveBeenCalled();
    expect(setGigachatApiKey).not.toHaveBeenCalled();
    expect(runtime.error).toHaveBeenCalledWith(
      expect.stringContaining("Basic user:password credentials"),
    );
    expect(runtime.exit).toHaveBeenCalledWith(1);
  });
});
