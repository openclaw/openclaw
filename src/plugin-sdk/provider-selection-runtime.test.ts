import { describe, expect, it } from "vitest";
import {
  resolveConfiguredCapabilityProvider,
  resolveProviderRawConfig,
  selectConfiguredOrAutoProvider,
  type AutoSelectableProvider,
} from "./provider-selection-runtime.js";

type TestProvider = AutoSelectableProvider & {
  configured?: boolean;
};

describe("plugin-sdk provider-selection-runtime", () => {
  const providers: TestProvider[] = [
    { id: "first", autoSelectOrder: 1 },
    { id: "second", autoSelectOrder: 2, configured: true },
  ];

  it("selects an explicit provider when it exists", () => {
    const selection = selectConfiguredOrAutoProvider({
      configuredProviderId: " second ",
      getConfiguredProvider: (providerId) => providers.find((entry) => entry.id === providerId),
      listProviders: () => providers,
    });

    expect(selection).toEqual({
      configuredProviderId: "second",
      missingConfiguredProvider: false,
      provider: providers[1],
    });
  });

  it("reports a missing explicit provider", () => {
    const resolution = resolveConfiguredCapabilityProvider({
      configuredProviderId: "missing",
      cfg: {},
      cfgForResolve: {},
      getConfiguredProvider: (providerId) => providers.find((entry) => entry.id === providerId),
      listProviders: () => providers,
      resolveProviderConfig: ({ rawConfig }) => rawConfig,
      isProviderConfigured: ({ provider }) => provider.configured === true,
    });

    expect(resolution).toEqual({
      ok: false,
      code: "missing-configured-provider",
      configuredProviderId: "missing",
    });
  });

  it("auto-selects the first configured provider by order", () => {
    const resolution = resolveConfiguredCapabilityProvider({
      cfg: {},
      cfgForResolve: {},
      getConfiguredProvider: (providerId) => providers.find((entry) => entry.id === providerId),
      listProviders: () => providers,
      resolveProviderConfig: ({ provider, rawConfig }) => ({
        ...rawConfig,
        providerId: provider.id,
      }),
      isProviderConfigured: ({ providerConfig }) => providerConfig.providerId === "second",
    });

    expect(resolution.ok).toBe(true);
    if (!resolution.ok) {
      throw new Error("expected provider resolution to succeed");
    }
    expect(resolution.provider).toBe(providers[1]);
    expect(resolution.providerConfig).toEqual({ providerId: "second" });
  });

  it("passes explicit selection metadata to provider configuration checks", () => {
    const seen: Array<{
      providerId: string;
      configuredProviderId?: string;
      providerConfigExplicit: boolean;
    }> = [];
    const resolution = resolveConfiguredCapabilityProvider({
      configuredProviderId: "second",
      providerConfigs: {
        second: { enabled: true },
      },
      cfg: {},
      cfgForResolve: {},
      getConfiguredProvider: (providerId) => providers.find((entry) => entry.id === providerId),
      listProviders: () => providers,
      resolveProviderConfig: ({ rawConfig }) => rawConfig,
      isProviderConfigured: ({ provider, configuredProviderId, providerConfigExplicit }) => {
        seen.push({
          providerId: provider.id,
          configuredProviderId,
          providerConfigExplicit,
        });
        return true;
      },
    });

    expect(resolution.ok).toBe(true);
    expect(seen).toEqual([
      {
        providerId: "second",
        configuredProviderId: "second",
        providerConfigExplicit: true,
      },
    ]);
  });

  it("merges canonical and selected provider config", () => {
    expect(
      resolveProviderRawConfig({
        providerId: "canonical",
        configuredProviderId: "alias",
        providerConfigs: {
          canonical: { apiKey: "default", model: "base" },
          alias: { model: "alias-model" },
        },
      }),
    ).toEqual({
      apiKey: "default",
      model: "alias-model",
    });
  });
});
