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

const commandError = "Paste the API key value, not an OpenClaw onboarding command.";
const malformedKey = "openclaw onboard --non-interactive --auth-choice fixture-api-key";
type RejectedCase = Partial<Parameters<typeof resolveNonInteractiveApiKey>[0]> & {
  expectedMessage: string;
  envCalls: number;
  explicitEnvKey?: string;
  resolvedEnv?: { apiKey: string; source: string };
};

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

  it.each<RejectedCase>([
    { expectedMessage: "Missing --custom-api-key", envCalls: 1 },
    {
      expectedMessage: commandError,
      flagValue: malformedKey,
      envCalls: 0,
    },
    {
      expectedMessage: `${commandError} Check CUSTOM_API_KEY.`,
      resolvedEnv: { apiKey: malformedKey, source: "env: CUSTOM_API_KEY" },
      envCalls: 1,
    },
    {
      expectedMessage: `${commandError} Check CUSTOM_API_KEY.`,
      resolvedEnv: { apiKey: malformedKey, source: "env: CUSTOM_API_KEY" },
      secretInputMode: "ref",
      envCalls: 1,
    },
    {
      expectedMessage: `${commandError} Check CUSTOM_API_KEY.`,
      flagValue: "fixture-key",
      explicitEnvKey: malformedKey,
      secretInputMode: "ref",
      envCalls: 0,
    },
    {
      expectedMessage: "cannot be used with --secret-input-mode ref",
      flagValue: "custom-inline-key-should-not-leak",
      secretInputMode: "ref",
      envCalls: 0,
    },
    {
      expectedMessage: "requires an explicit environment variable",
      envVar: "",
      secretInputMode: "ref",
      resolvedEnv: { apiKey: "fixture-api-key", source: "provider discovery" },
      envCalls: 1,
    },
  ])("rejects invalid credentials with one JSON error: %j", async (testCase) => {
    resolveEnvApiKey.mockReturnValue(testCase.resolvedEnv ?? null);
    await withEnvAsync({ CUSTOM_API_KEY: testCase.explicitEnvKey }, async () => {
      expect(await resolveKey({ ...testCase, json: true })).toBeNull();
      expect(resolveEnvApiKey).toHaveBeenCalledTimes(testCase.envCalls);
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
      if (testCase.expectedMessage.startsWith(commandError)) {
        expect(payload.message).toBe(testCase.expectedMessage);
      }
      if (testCase.flagValue === "custom-inline-key-should-not-leak") {
        expect(payload.message).toContain("--custom-api-key");
        expect(payload.message).toContain("CUSTOM_API_KEY");
        expect(
          runtime.error.mock.calls.map(([message]) => String(message)).join("\n"),
        ).not.toContain(testCase.flagValue);
      }
    });
  });
});
