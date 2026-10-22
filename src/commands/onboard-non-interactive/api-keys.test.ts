// Non-interactive API key tests cover flag, environment, auth-profile, and secret-ref mode precedence.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createApiKeyCredential } from "../../agents/auth-profiles/credential-fixtures.test-support.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { resolveNonInteractiveApiKey } from "./api-keys.js";

const resolveEnvApiKey = vi.hoisted(() => vi.fn());
vi.mock("../../agents/model-auth.js", () => ({
  resolveEnvApiKey,
}));

const authStore = vi.hoisted(() => ({
  version: 1 as const,
  profiles: {} as Record<string, { type: "api_key"; provider: string; key: string }>,
}));
// mock-isolation: Key-precedence tests inspect synthetic accounts without reading host secrets.
vi.mock("../../agents/auth-profiles.js", () => ({
  ensureAuthProfileStoreAsync: vi.fn(async () => authStore),
  resolveApiKeyForProfile: vi.fn(async ({ profileId }: { profileId: string }) => {
    const profile = authStore.profiles[profileId];
    return profile?.type === "api_key" ? { apiKey: profile.key, source: "profile" } : null;
  }),
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

const zaiOptions = { provider: "zai", flagName: "--zai-api-key", envVar: "ZAI_API_KEY" };
const commandError = "Paste the API key value, not an OpenClaw onboarding command.";

function expectRejected(result: unknown, message: string, envCalls = 0) {
  expect(result).toBeNull();
  expect(resolveEnvApiKey).toHaveBeenCalledTimes(envCalls);
  expect(runtime.error).toHaveBeenCalledWith(message);
  expect(runtime.exit).toHaveBeenCalledWith(1);
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
        ...zaiOptions,
        flagValue: resolvedEnv ? undefined : malformedKey,
        secretInputMode,
      });

      expectRejected(
        result,
        resolvedEnv ? `${commandError} Check ZAI_API_KEY.` : commandError,
        resolvedEnv ? 1 : 0,
      );
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
          ...zaiOptions,
          flagValue: "zai-flag-key",
          secretInputMode: "ref",
        });

        expectRejected(result, `${commandError} Check ZAI_API_KEY.`);
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

  it.each([
    ["env", { key: "custom-env-key", source: "env", envVarName: "CUSTOM_API_KEY" }],
    ["profile", { key: "fixture-profile-key", source: "profile" }],
    ["optional", null],
  ] as const)("falls back to %s when provider env discovery misses", async (source, expected) => {
    const key = expected?.key;
    resolveEnvApiKey.mockReturnValue(null);
    if (source === "profile" && key) {
      authStore.profiles["custom-models-custom-local:default"] = createApiKeyCredential(
        "custom-models-custom-local",
        key,
      );
    }
    await withEnvAsync({ CUSTOM_API_KEY: source === "env" ? key : undefined }, async () => {
      expect(
        await resolveKey({
          envVarName: "CUSTOM_API_KEY",
          required: source !== "optional",
          secretInputMode: source === "env" ? undefined : "ref",
        }),
      ).toEqual(expected);
      expect(runtime.error).not.toHaveBeenCalled();
      expect(runtime.exit).not.toHaveBeenCalled();
    });
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
