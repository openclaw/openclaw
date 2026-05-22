// Verifies provider usage telemetry preserves plugin auth context.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

type ResolveUsageAuthPluginParams = {
  context: {
    resolveOAuthToken(params: { provider: string }): Promise<unknown>;
  };
};

const resolveProviderUsageAuthWithPluginMock = vi.fn(
  async (_params: ResolveUsageAuthPluginParams): Promise<unknown> => null,
);
const hasAnyAuthProfileStoreSourceMock = vi.fn(() => false);
const ensureAuthProfileStoreMock = vi.fn(() => ({
  profiles: {},
}));
const ensureAuthProfileStoreWithoutExternalProfilesMock = vi.fn(() => ({
  profiles: {},
}));
const resolveAuthProfileOrderMock = vi.fn((_params: unknown): string[] => []);
const resolveApiKeyForProfileMock = vi.fn(async (_params: unknown) => null);

vi.mock("../agents/auth-profiles.js", () => ({
  dedupeProfileIds: (profileIds: string[]) => [...new Set(profileIds)],
  ensureAuthProfileStore: () => ensureAuthProfileStoreMock(),
  ensureAuthProfileStoreWithoutExternalProfiles: () =>
    ensureAuthProfileStoreWithoutExternalProfilesMock(),
  hasAnyAuthProfileStoreSource: () => hasAnyAuthProfileStoreSourceMock(),
  listProfilesForProvider: () => [],
  resolveApiKeyForProfile: (params: unknown) => resolveApiKeyForProfileMock(params),
  resolveAuthProfileOrder: (params: unknown) => resolveAuthProfileOrderMock(params),
}));

vi.mock("../plugins/provider-runtime.js", async () => {
  const actual = await vi.importActual<typeof import("../plugins/provider-runtime.js")>(
    "../plugins/provider-runtime.js",
  );
  return {
    ...actual,
    resolveProviderUsageAuthWithPlugin: resolveProviderUsageAuthWithPluginMock,
  };
});

vi.mock("../plugins/manifest-contract-eligibility.js", () => ({
  loadManifestMetadataSnapshot: () => ({
    plugins: [
      {
        id: "minimax",
        origin: "bundled",
        providers: ["minimax", "minimax-portal"],
      },
    ],
  }),
}));

vi.mock("../secrets/provider-env-vars.js", () => ({
  resolveProviderAuthEvidence: () => ({}),
  resolveProviderAuthEnvVarCandidates: () => ({
    anthropic: ["ANTHROPIC_API_KEY"],
    minimax: ["MINIMAX_CODE_PLAN_KEY"],
  }),
  resolveProviderAuthLookupMaps: () => ({
    aliasMap: {},
    envCandidateMap: {
      anthropic: ["ANTHROPIC_API_KEY"],
      minimax: ["MINIMAX_CODE_PLAN_KEY"],
    },
    authEvidenceMap: {},
  }),
}));

let resolveProviderAuths: typeof import("./provider-usage.auth.js").resolveProviderAuths;

function resolveProviderAuthsForTest(
  params: Parameters<typeof resolveProviderAuths>[0],
): ReturnType<typeof resolveProviderAuths> {
  return resolveProviderAuths({
    config: {},
    ...params,
  });
}

async function withTempHome<T>(fn: (homeDir: string) => Promise<T>): Promise<T> {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-provider-usage-"));
  try {
    return await fn(homeDir);
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
}

function providerCalls(mockFn: { mock: { calls: unknown[][] } }): unknown[] {
  return mockFn.mock.calls.map(([params]) =>
    params && typeof params === "object" && "provider" in params
      ? (params as { provider?: unknown }).provider
      : undefined,
  );
}

describe("resolveProviderAuths plugin boundary", () => {
  beforeAll(async () => {
    ({ resolveProviderAuths } = await import("./provider-usage.auth.js"));
  });

  beforeEach(() => {
    hasAnyAuthProfileStoreSourceMock.mockReset();
    hasAnyAuthProfileStoreSourceMock.mockReturnValue(false);
    ensureAuthProfileStoreMock.mockClear();
    ensureAuthProfileStoreMock.mockReturnValue({
      profiles: {},
    });
    ensureAuthProfileStoreWithoutExternalProfilesMock.mockClear();
    ensureAuthProfileStoreWithoutExternalProfilesMock.mockReturnValue({
      profiles: {},
    });
    resolveAuthProfileOrderMock.mockReset();
    resolveAuthProfileOrderMock.mockReturnValue([]);
    resolveApiKeyForProfileMock.mockReset();
    resolveApiKeyForProfileMock.mockResolvedValue(null);
    resolveProviderUsageAuthWithPluginMock.mockReset();
    resolveProviderUsageAuthWithPluginMock.mockResolvedValue(null);
  });

  it("prefers plugin-owned usage auth when available", async () => {
    resolveProviderUsageAuthWithPluginMock.mockResolvedValueOnce({
      token: "plugin-zai-token",
    });

    await expect(
      resolveProviderAuthsForTest({
        providers: ["zai"],
      }),
    ).resolves.toEqual([
      {
        provider: "zai",
        token: "plugin-zai-token",
      },
    ]);
    expect(ensureAuthProfileStoreMock).not.toHaveBeenCalled();
  });

  it("does not synthesize Codex app-server auth for generic OpenAI usage", async () => {
    await expect(
      resolveProviderAuthsForTest({
        providers: ["openai"],
      }),
    ).resolves.toEqual([]);
    expect(providerCalls(resolveProviderUsageAuthWithPluginMock)).toEqual(["openai"]);
  });

  it("skips plugin usage auth when requested and no direct credential source exists", async () => {
    await withTempHome(async (homeDir) => {
      await expect(
        resolveProviderAuthsForTest({
          providers: ["zai"],
          skipPluginAuthWithoutCredentialSource: true,
          env: { HOME: homeDir },
        }),
      ).resolves.toStrictEqual([]);
    });

    expect(resolveProviderUsageAuthWithPluginMock).not.toHaveBeenCalled();
    expect(ensureAuthProfileStoreMock).not.toHaveBeenCalled();
  });

  it("keeps auth-profile credential sources provider-specific", async () => {
    hasAnyAuthProfileStoreSourceMock.mockReturnValue(true);
    ensureAuthProfileStoreWithoutExternalProfilesMock.mockReturnValue({
      profiles: {
        "anthropic:default": {
          type: "api_key",
          provider: "anthropic",
          key: "sk-ant",
        },
      },
    });
    resolveAuthProfileOrderMock.mockImplementation((params: unknown) => {
      const provider =
        params && typeof params === "object" && "provider" in params
          ? (params as { provider?: unknown }).provider
          : undefined;
      return provider === "anthropic" ? ["anthropic:default"] : [];
    });
    resolveProviderUsageAuthWithPluginMock.mockResolvedValueOnce({
      token: "plugin-anthropic-token",
    });

    await withTempHome(async (homeDir) => {
      await expect(
        resolveProviderAuthsForTest({
          providers: ["anthropic", "zai"],
          skipPluginAuthWithoutCredentialSource: true,
          env: { HOME: homeDir },
        }),
      ).resolves.toEqual([
        {
          provider: "anthropic",
          token: "plugin-anthropic-token",
        },
      ]);
    });

    expect(resolveProviderUsageAuthWithPluginMock).toHaveBeenCalledTimes(1);
    expect(providerCalls(resolveProviderUsageAuthWithPluginMock)).toEqual(["anthropic"]);
    expect(ensureAuthProfileStoreMock).not.toHaveBeenCalled();
  });

  it("keeps plugin usage auth when an owned alias provider has auth-profile credentials", async () => {
    hasAnyAuthProfileStoreSourceMock.mockReturnValue(true);
    ensureAuthProfileStoreWithoutExternalProfilesMock.mockReturnValue({
      profiles: {
        "minimax-portal:default": {
          type: "oauth",
          provider: "minimax-portal",
          accessToken: "portal-oauth-token",
        },
      },
    });
    resolveAuthProfileOrderMock.mockImplementation((params: unknown) => {
      const provider =
        params && typeof params === "object" && "provider" in params
          ? (params as { provider?: unknown }).provider
          : undefined;
      return provider === "minimax-portal" ? ["minimax-portal:default"] : [];
    });
    resolveProviderUsageAuthWithPluginMock.mockResolvedValueOnce({
      token: "plugin-minimax-token",
    });

    await withTempHome(async (homeDir) => {
      await expect(
        resolveProviderAuthsForTest({
          providers: ["minimax"],
          skipPluginAuthWithoutCredentialSource: true,
          env: { HOME: homeDir },
        }),
      ).resolves.toEqual([
        {
          provider: "minimax",
          token: "plugin-minimax-token",
        },
      ]);
    });

    expect(providerCalls(resolveAuthProfileOrderMock)).toEqual(["minimax", "minimax-portal"]);
    expect(providerCalls(resolveProviderUsageAuthWithPluginMock)).toEqual(["minimax"]);
    expect(ensureAuthProfileStoreMock).not.toHaveBeenCalled();
  });

  it("keeps plugin usage auth when provider-owned usage env credentials exist", async () => {
    resolveProviderUsageAuthWithPluginMock.mockResolvedValueOnce({
      token: "plugin-minimax-token",
    });

    await withTempHome(async (homeDir) => {
      await expect(
        resolveProviderAuthsForTest({
          providers: ["minimax"],
          skipPluginAuthWithoutCredentialSource: true,
          env: {
            HOME: homeDir,
            MINIMAX_API_KEY: "code-plan-key",
          },
        }),
      ).resolves.toEqual([
        {
          provider: "minimax",
          token: "plugin-minimax-token",
        },
      ]);
    });

    expect(providerCalls(resolveProviderUsageAuthWithPluginMock)).toEqual(["minimax"]);
    expect(ensureAuthProfileStoreMock).not.toHaveBeenCalled();
  });

  it("uses cached OAuth access without refreshing when refresh is disabled", async () => {
    hasAnyAuthProfileStoreSourceMock.mockReturnValue(true);
    ensureAuthProfileStoreWithoutExternalProfilesMock.mockReturnValue({
      profiles: {
        "google-gemini-cli:default": {
          type: "oauth",
          provider: "google-gemini-cli",
          access: "cached-gemini-token",
          refresh: "refresh-token",
          expires: Date.now() + 60_000,
          accountId: "account-1",
        },
      },
    });
    ensureAuthProfileStoreMock.mockReturnValue({
      profiles: {
        "google-gemini-cli:default": {
          type: "oauth",
          provider: "google-gemini-cli",
          access: "cached-gemini-token",
          refresh: "refresh-token",
          expires: Date.now() + 60_000,
          accountId: "account-1",
        },
      },
    });
    resolveAuthProfileOrderMock.mockImplementation((params: unknown) => {
      const provider =
        params && typeof params === "object" && "provider" in params
          ? (params as { provider?: unknown }).provider
          : undefined;
      return provider === "google-gemini-cli" ? ["google-gemini-cli:default"] : [];
    });
    resolveProviderUsageAuthWithPluginMock.mockImplementationOnce(
      async (params: ResolveUsageAuthPluginParams) =>
        params.context.resolveOAuthToken({ provider: "google-gemini-cli" }),
    );

    await expect(
      resolveProviderAuths({
        providers: ["google-gemini-cli" as never],
        skipPluginAuthWithoutCredentialSource: true,
        allowOAuthRefresh: false,
      }),
    ).resolves.toEqual([
      {
        provider: "google-gemini-cli",
        token: "cached-gemini-token",
        accountId: "account-1",
      },
    ]);

    expect(resolveApiKeyForProfileMock).not.toHaveBeenCalled();
  });

  it("skips expired OAuth profiles without refreshing when refresh is disabled", async () => {
    hasAnyAuthProfileStoreSourceMock.mockReturnValue(true);
    const store = {
      profiles: {
        "google-gemini-cli:default": {
          type: "oauth",
          provider: "google-gemini-cli",
          access: "expired-gemini-token",
          refresh: "refresh-token",
          expires: Date.now() - 60_000,
        },
      },
    };
    ensureAuthProfileStoreWithoutExternalProfilesMock.mockReturnValue(store);
    ensureAuthProfileStoreMock.mockReturnValue(store);
    resolveAuthProfileOrderMock.mockReturnValue(["google-gemini-cli:default"]);
    resolveProviderUsageAuthWithPluginMock.mockImplementationOnce(
      async (params: ResolveUsageAuthPluginParams) =>
        params.context.resolveOAuthToken({ provider: "google-gemini-cli" }),
    );

    await expect(
      resolveProviderAuths({
        providers: ["google-gemini-cli" as never],
        skipPluginAuthWithoutCredentialSource: true,
        allowOAuthRefresh: false,
      }),
    ).resolves.toEqual([]);

    expect(resolveApiKeyForProfileMock).not.toHaveBeenCalled();
  });

  it("does not overlay external auth profiles while checking the skip gate", async () => {
    hasAnyAuthProfileStoreSourceMock.mockReturnValue(true);

    await withTempHome(async (homeDir) => {
      await expect(
        resolveProviderAuthsForTest({
          providers: ["anthropic"],
          skipPluginAuthWithoutCredentialSource: true,
          env: { HOME: homeDir },
        }),
      ).resolves.toStrictEqual([]);
    });

    expect(ensureAuthProfileStoreWithoutExternalProfilesMock).toHaveBeenCalledTimes(1);
    expect(ensureAuthProfileStoreMock).not.toHaveBeenCalled();
    expect(resolveProviderUsageAuthWithPluginMock).not.toHaveBeenCalled();
  });

  it("does not fall back to standard Anthropic API keys for usage auth", async () => {
    resolveProviderUsageAuthWithPluginMock.mockResolvedValueOnce({ handled: true });
    await withTempHome(async (homeDir) => {
      await expect(
        resolveProviderAuthsForTest({
          providers: ["anthropic", "zai"],
          skipPluginAuthWithoutCredentialSource: true,
          env: {
            HOME: homeDir,
            ANTHROPIC_API_KEY: "sk-ant-api03-status-key", // pragma: allowlist secret
          },
        }),
      ).resolves.toEqual([]);
    });

    expect(resolveProviderUsageAuthWithPluginMock).toHaveBeenCalledTimes(1);
    expect(providerCalls(resolveProviderUsageAuthWithPluginMock)).toEqual(["anthropic"]);
  });
});
