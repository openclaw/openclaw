import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { loadPreferredProviderPickerCatalog } from "./model-picker.provider-catalog.js";

const providerCatalogMocks = vi.hoisted(() => ({
  resolveProviderCatalogPluginIdsForFilter: vi.fn(),
}));

vi.mock("../commands/models/list.provider-catalog.js", () => providerCatalogMocks);

const providerDiscoveryMocks = vi.hoisted(() => ({
  groupPluginDiscoveryProvidersByOrder: vi.fn((providers: unknown[]) => ({
    simple: providers,
    profile: [],
    paired: [],
    late: [],
  })),
  normalizePluginDiscoveryResult: vi.fn(
    ({
      provider,
      result,
    }: {
      provider: { id: string; aliases?: string[]; hookAliases?: string[] };
      result: unknown;
    }) => {
      if (!result || typeof result !== "object") {
        return {};
      }
      if ("provider" in result) {
        const rows: Record<string, unknown> = {};
        for (const providerId of [
          provider.id,
          ...(provider.aliases ?? []),
          ...(provider.hookAliases ?? []),
        ]) {
          const normalized = providerId.trim().toLowerCase();
          if (normalized) {
            rows[normalized] = result.provider;
          }
        }
        return rows;
      }
      if ("providers" in result && result.providers && typeof result.providers === "object") {
        return result.providers;
      }
      return {};
    },
  ),
  resolveRuntimePluginDiscoveryProviders: vi.fn(),
  runProviderCatalog: vi.fn(),
}));

vi.mock("../plugins/provider-discovery.js", () => providerDiscoveryMocks);

const authProfileMocks = vi.hoisted(() => ({
  ensureAuthProfileStoreWithoutExternalProfiles: vi.fn(() => ({
    version: 1,
    profiles: {},
  })),
}));

vi.mock("../agents/auth-profiles.js", () => authProfileMocks);

const providerSecretMocks = vi.hoisted(() => {
  const resolveProviderApiKey = vi.fn(() => ({
    apiKey: undefined,
    discoveryApiKey: undefined,
  }));
  const resolveProviderAuth = vi.fn(() => undefined);
  return {
    createProviderApiKeyResolver: vi.fn(() => resolveProviderApiKey),
    createProviderAuthResolver: vi.fn(() => resolveProviderAuth),
    resolveProviderApiKey,
    resolveProviderAuth,
  };
});

vi.mock("../agents/models-config.providers.secrets.js", () => providerSecretMocks);

beforeEach(() => {
  vi.clearAllMocks();
  providerCatalogMocks.resolveProviderCatalogPluginIdsForFilter.mockResolvedValue(["openai"]);
  providerDiscoveryMocks.resolveRuntimePluginDiscoveryProviders.mockResolvedValue([
    {
      id: "openai",
      aliases: ["openai-codex"],
      hookAliases: ["codex"],
      envVars: [],
    },
  ]);
});

describe("loadPreferredProviderPickerCatalog", () => {
  it("keeps canonical catalog rows when the preferred provider matches an alias", async () => {
    providerDiscoveryMocks.runProviderCatalog.mockResolvedValue({
      provider: {
        models: [
          {
            id: "gpt-5.5",
            name: "GPT-5.5",
            reasoning: true,
            input: ["text"],
          },
        ],
      },
    });

    const rows = await loadPreferredProviderPickerCatalog({
      cfg: {} as OpenClawConfig,
      preferredProvider: "openai-codex",
      agentDir: "/tmp/openclaw-test-agent",
      env: {},
    });

    expect(rows).toEqual([
      {
        provider: "openai",
        id: "gpt-5.5",
        name: "GPT-5.5",
        reasoning: true,
        input: ["text"],
      },
    ]);
    expect(providerDiscoveryMocks.runProviderCatalog).toHaveBeenCalledOnce();
  });

  it("passes the environment API key value to provider catalog hooks", async () => {
    providerDiscoveryMocks.resolveRuntimePluginDiscoveryProviders.mockResolvedValue([
      {
        id: "openai",
        aliases: ["openai-codex"],
        hookAliases: [],
        envVars: ["OPENAI_API_KEY"],
      },
    ]);
    providerDiscoveryMocks.runProviderCatalog.mockImplementationOnce(async (params) => {
      expect(params.resolveProviderApiKey("openai")).toEqual({
        apiKey: "sk-test",
        discoveryApiKey: "sk-test",
      });
      return {
        provider: {
          models: [],
        },
      };
    });

    await loadPreferredProviderPickerCatalog({
      cfg: {} as OpenClawConfig,
      preferredProvider: "openai-codex",
      agentDir: "/tmp/openclaw-test-agent",
      env: {
        OPENAI_API_KEY: "sk-test",
      },
    });

    expect(providerDiscoveryMocks.runProviderCatalog).toHaveBeenCalledOnce();
  });
});
