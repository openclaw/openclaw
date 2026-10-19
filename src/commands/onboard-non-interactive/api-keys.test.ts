// Non-interactive API key tests cover flag, environment, auth-profile, and secret-ref mode precedence.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createApiKeyCredential } from "../../agents/auth-profiles/credential-fixtures.test-support.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { resolveNonInteractiveApiKey } from "./api-keys.js";

const resolveEnvApiKey = vi.hoisted(() => vi.fn());
vi.mock("../../agents/model-auth.js", () => ({
  resolveEnvApiKey,
}));

const authStore = vi.hoisted(
  () =>
    ({
      version: 1,
      profiles: {} as Record<string, { type: "api_key"; provider: string; key: string }>,
    }) as const,
);
const resolveApiKeyForProfile = vi.hoisted(() =>
  vi.fn(async (params: { profileId: string }) => {
    const profile = authStore.profiles[params.profileId];
    return profile?.type === "api_key" ? { apiKey: profile.key, source: "profile" } : null;
  }),
);
// mock-isolation: Key-precedence tests inspect synthetic accounts without reading host secrets.
vi.mock("../../agents/auth-profiles.js", () => ({
  ensureAuthProfileStoreAsync: vi.fn(async () => authStore),
  resolveApiKeyForProfile,
  resolveAuthProfileOrder: vi.fn(() => Object.keys(authStore.profiles)),
}));

beforeEach(() => {
  vi.clearAllMocks();
  for (const profileId of Object.keys(authStore.profiles)) {
    delete authStore.profiles[profileId];
  }
});

const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };

function resolveKey(options: Partial<Parameters<typeof resolveNonInteractiveApiKey>[0]> = {}) {
  return resolveNonInteractiveApiKey({
    provider: "custom-models-custom-local",
    cfg: {},
    flagName: "--custom-api-key",
    envVar: "CUSTOM_API_KEY",
    ...options,
    runtime,
  });
}

describe("resolveNonInteractiveApiKey", () => {
  it("resolves provider environment auth against the staged config and agent workspace", async () => {
    const cfg = { plugins: { entries: { example: { enabled: true } } } };
    const workspaceDir = "/tmp/openclaw-example-workspace";
    resolveEnvApiKey.mockReturnValue({
      apiKey: "example-manifest-key",
      source: "env: EXAMPLE_WORKSPACE_API_KEY",
    });

    const result = await resolveKey({
      provider: "example",
      cfg,
      workspaceDir,
      flagName: "--example-api-key",
      envVar: "EXAMPLE_API_KEY",
    });

    expect(result).toEqual({
      key: "example-manifest-key",
      source: "env",
      envVarName: "EXAMPLE_WORKSPACE_API_KEY",
    });
    expect(resolveEnvApiKey).toHaveBeenCalledWith("example", process.env, {
      config: cfg,
      workspaceDir,
    });
    expect(runtime.exit).not.toHaveBeenCalled();
  });

  it("returns explicit flag keys before resolving env or plugin-backed setup", async () => {
    resolveEnvApiKey.mockImplementation(() => {
      throw new Error("env lookup should not run for an explicit plaintext flag");
    });

    const result = await resolveKey({
      provider: "xai",
      flagValue: "xai-flag-key",
      flagName: "--xai-api-key",
      envVar: "XAI_API_KEY",
    });

    expect(result).toEqual({ key: "xai-flag-key", source: "flag" });
    expect(resolveEnvApiKey).not.toHaveBeenCalled();
    expect(runtime.exit).not.toHaveBeenCalled();
  });

  it.each([
    ["flag", false, undefined],
    ["environment", true, undefined],
    ["secret-ref environment", true, "ref"],
  ] as const)(
    "rejects command-shaped %s keys before returning them",
    async (_, resolvedEnv, secretInputMode) => {
      const malformedKey =
        "openclaw onboard --non-interactive --auth-choice=zai-coding-global --zai-api-key $ZAI_API_KEY";
      if (resolvedEnv) {
        resolveEnvApiKey.mockReturnValue({
          apiKey: malformedKey,
          source: "env: ZAI_API_KEY",
        });
      } else {
        resolveEnvApiKey.mockImplementation(() => {
          throw new Error("env lookup should not run for a malformed explicit flag");
        });
      }

      const result = await resolveKey({
        provider: "zai",
        flagValue: resolvedEnv ? undefined : malformedKey,
        flagName: "--zai-api-key",
        envVar: "ZAI_API_KEY",
        secretInputMode,
      });

      expect(result).toBeNull();
      expect(resolveEnvApiKey).toHaveBeenCalledTimes(resolvedEnv ? 1 : 0);
      expect(runtime.error).toHaveBeenCalledWith(
        resolvedEnv
          ? "Paste the API key value, not an OpenClaw onboarding command. Check ZAI_API_KEY."
          : "Paste the API key value, not an OpenClaw onboarding command.",
      );
      expect(runtime.exit).toHaveBeenCalledWith(1);
    },
  );

  it("rejects a command-shaped explicit env key before a secret-ref flag", async () => {
    resolveEnvApiKey.mockImplementation(() => {
      throw new Error("broad env lookup should not run for an explicit ref-mode flag");
    });

    await withEnvAsync(
      { ZAI_API_KEY: "openclaw onboard --non-interactive --auth-choice zai-api-key" },
      async () => {
        const result = await resolveKey({
          provider: "zai",
          flagValue: "zai-flag-key",
          flagName: "--zai-api-key",
          envVar: "ZAI_API_KEY",
          secretInputMode: "ref",
        });

        expect(result).toBeNull();
        expect(resolveEnvApiKey).not.toHaveBeenCalled();
        expect(runtime.error).toHaveBeenCalledWith(
          "Paste the API key value, not an OpenClaw onboarding command. Check ZAI_API_KEY.",
        );
        expect(runtime.exit).toHaveBeenCalledWith(1);
      },
    );
  });

  it("rejects literal ref-mode input without broad env discovery or leaking the key", async () => {
    const flagValue = "custom-inline-key-should-not-leak";
    const flagName = "--custom-api-key";
    const envVar = "CUSTOM_API_KEY";
    resolveEnvApiKey.mockReturnValue(null);
    await withEnvAsync({ [envVar]: undefined }, async () => {
      const result = await resolveKey({
        flagValue,
        flagName,
        envVar,
        secretInputMode: "ref",
      });

      const errorText = runtime.error.mock.calls.map(([message]) => String(message)).join("\n");
      expect(result).toBeNull();
      expect(resolveEnvApiKey).not.toHaveBeenCalled();
      expect(runtime.exit).toHaveBeenCalledWith(1);
      expect(errorText).toContain(flagName);
      expect(errorText).toContain(envVar);
      expect(errorText).not.toContain(flagValue);
    });
  });

  it("returns explicit env fallback keys when provider env discovery misses", async () => {
    resolveEnvApiKey.mockReturnValue(null);
    await withEnvAsync({ CUSTOM_API_KEY: "custom-env-key" }, async () => {
      const result = await resolveKey({ envVarName: "CUSTOM_API_KEY" });

      expect(result).toEqual({
        key: "custom-env-key",
        source: "env",
        envVarName: "CUSTOM_API_KEY",
      });
      expect(runtime.exit).not.toHaveBeenCalled();
    });
  });

  it("retains existing profile reuse in secret-ref mode without inventing an env reference", async () => {
    authStore.profiles["custom-models-custom-local:default"] = createApiKeyCredential(
      "custom-models-custom-local",
      "fixture-profile-key",
    );
    resolveEnvApiKey.mockReturnValue(null);

    const result = await resolveKey({ secretInputMode: "ref" });

    expect(result).toEqual({ key: "fixture-profile-key", source: "profile" });
    expect(runtime.error).not.toHaveBeenCalled();
    expect(runtime.exit).not.toHaveBeenCalled();
  });

  it("keeps intentionally keyless providers optional in secret-ref mode", async () => {
    resolveEnvApiKey.mockReturnValue(null);

    const result = await resolveKey({ required: false, secretInputMode: "ref" });

    expect(result).toBeNull();
    expect(runtime.error).not.toHaveBeenCalled();
    expect(runtime.exit).not.toHaveBeenCalled();
  });

  it.each([
    { expectedMessage: "Missing --fixture-api-key" },
    {
      expectedMessage: "Paste the API key value",
      flagValue: "openclaw onboard --non-interactive --auth-choice fixture-api-key",
    },
    {
      expectedMessage: "cannot be used with --secret-input-mode ref",
      flagValue: "fixture-api-key",
      secretInputMode: "ref" as const,
    },
    {
      expectedMessage: "requires an explicit environment variable",
      envVar: "",
      secretInputMode: "ref" as const,
      resolvedEnv: { apiKey: "fixture-api-key", source: "provider discovery" },
    },
  ])("emits one options JSON object for $expectedMessage", async (testCase) => {
    resolveEnvApiKey.mockReturnValue(testCase.resolvedEnv ?? null);

    const result = await resolveKey({
      provider: "fixture",
      flagName: "--fixture-api-key",
      envVar: testCase.envVar ?? "OPENCLAW_ONBOARD_MISSING_FIXTURE_KEY",
      flagValue: testCase.flagValue,
      secretInputMode: testCase.secretInputMode,
      json: true,
    });

    expect(result).toBeNull();
    expect(runtime.exit).toHaveBeenCalledWith(1);
    expect(runtime.log).toHaveBeenCalledOnce();
    const payload = JSON.parse(String(runtime.log.mock.calls[0]?.[0]));
    expect(payload).toEqual({
      ok: false,
      error: { type: "cli_error", message: expect.stringContaining(testCase.expectedMessage) },
      phase: "options",
      message: expect.stringContaining(testCase.expectedMessage),
    });
    expect(runtime.error).toHaveBeenCalledWith(payload.message);
  });
});
