import { beforeEach, describe, expect, it, vi } from "vitest";
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
vi.mock("../../agents/auth-profiles.js", () => ({
  ensureAuthProfileStore: vi.fn(() => authStore),
  resolveApiKeyForProfile,
  resolveAuthProfileOrder: vi.fn(() => Object.keys(authStore.profiles)),
}));

beforeEach(() => {
  vi.clearAllMocks();
  for (const profileId of Object.keys(authStore.profiles)) {
    delete authStore.profiles[profileId];
  }
});

function createRuntime() {
  return {
    error: vi.fn(),
    exit: vi.fn(),
  };
}

describe("resolveNonInteractiveApiKey", () => {
  it("returns explicit flag keys before resolving env or plugin-backed setup", async () => {
    const runtime = createRuntime();
    resolveEnvApiKey.mockImplementation(() => {
      throw new Error("env lookup should not run for an explicit plaintext flag");
    });

    const result = await resolveNonInteractiveApiKey({
      provider: "xai",
      cfg: {},
      flagValue: "xai-flag-key",
      flagName: "--xai-api-key",
      envVar: "XAI_API_KEY",
      runtime: runtime as never,
    });

    expect(result).toEqual({ key: "xai-flag-key", source: "flag" });
    expect(resolveEnvApiKey).not.toHaveBeenCalled();
    expect(runtime.exit).not.toHaveBeenCalled();
  });

  it("rejects flag input in secret-ref mode without broad env discovery", async () => {
    const runtime = createRuntime();
    resolveEnvApiKey.mockReturnValue(null);
    const previousXaiApiKey = process.env.XAI_API_KEY;
    delete process.env.XAI_API_KEY;

    try {
      const result = await resolveNonInteractiveApiKey({
        provider: "xai",
        cfg: {},
        flagValue: "xai-flag-key",
        flagName: "--xai-api-key",
        envVar: "XAI_API_KEY",
        runtime: runtime as never,
        secretInputMode: "ref",
      });

      expect(result).toBeNull();
      expect(resolveEnvApiKey).not.toHaveBeenCalled();
      expect(runtime.exit).toHaveBeenCalledWith(1);
      expect(runtime.error).toHaveBeenCalledWith(
        expect.stringContaining("--secret-input-mode ref"),
      );
    } finally {
      if (previousXaiApiKey === undefined) {
        delete process.env.XAI_API_KEY;
      } else {
        process.env.XAI_API_KEY = previousXaiApiKey;
      }
    }
  });

  it("returns explicit env fallback keys when provider env discovery misses", async () => {
    const runtime = createRuntime();
    resolveEnvApiKey.mockReturnValue(null);
    const previousCustomApiKey = process.env.CUSTOM_API_KEY;
    process.env.CUSTOM_API_KEY = "custom-env-key"; // pragma: allowlist secret

    try {
      const result = await resolveNonInteractiveApiKey({
        provider: "custom-models-custom-local",
        cfg: {},
        flagName: "--custom-api-key",
        envVar: "CUSTOM_API_KEY",
        envVarName: "CUSTOM_API_KEY",
        runtime: runtime as never,
      });

      expect(result).toEqual({
        key: "custom-env-key",
        source: "env",
        envVarName: "CUSTOM_API_KEY",
      });
      expect(runtime.exit).not.toHaveBeenCalled();
    } finally {
      if (previousCustomApiKey === undefined) {
        delete process.env.CUSTOM_API_KEY;
      } else {
        process.env.CUSTOM_API_KEY = previousCustomApiKey;
      }
    }
  });

  it("returns explicit env fallback refs in secret-ref mode", async () => {
    const runtime = createRuntime();
    resolveEnvApiKey.mockReturnValue(null);
    const previousCustomApiKey = process.env.CUSTOM_API_KEY;
    process.env.CUSTOM_API_KEY = "custom-env-key"; // pragma: allowlist secret

    try {
      const result = await resolveNonInteractiveApiKey({
        provider: "custom-models-custom-local",
        cfg: {},
        flagName: "--custom-api-key",
        envVar: "CUSTOM_API_KEY",
        envVarName: "CUSTOM_API_KEY",
        runtime: runtime as never,
        secretInputMode: "ref",
      });

      expect(result).toEqual({
        key: "custom-env-key",
        source: "env",
        envVarName: "CUSTOM_API_KEY",
      });
      expect(runtime.exit).not.toHaveBeenCalled();
    } finally {
      if (previousCustomApiKey === undefined) {
        delete process.env.CUSTOM_API_KEY;
      } else {
        process.env.CUSTOM_API_KEY = previousCustomApiKey;
      }
    }
  });

  it("falls back to a matching API-key profile after flag and env are absent", async () => {
    const runtime = createRuntime();
    authStore.profiles["custom-models-custom-local:default"] = {
      type: "api_key",
      provider: "custom-models-custom-local",
      key: "custom-profile-key",
    };
    resolveEnvApiKey.mockReturnValue(null);

    const result = await resolveNonInteractiveApiKey({
      provider: "custom-models-custom-local",
      cfg: {},
      flagName: "--custom-api-key",
      envVar: "CUSTOM_API_KEY",
      runtime: runtime as never,
    });

    expect(result).toEqual({ key: "custom-profile-key", source: "profile" });
    expect(resolveApiKeyForProfile).toHaveBeenCalledWith(
      expect.objectContaining({
        profileId: "custom-models-custom-local:default",
      }),
    );
  });
});
