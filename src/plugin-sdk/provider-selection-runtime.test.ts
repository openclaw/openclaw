import { describe, expect, it, vi } from "vitest";
import { withPluginRuntimePluginScope } from "../plugins/runtime/gateway-request-scope.js";
import {
  resolveConfiguredCapabilityProvider,
  resolveConfiguredCapabilityProviderAsync,
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
  const params = {
    cfg: {},
    cfgForResolve: {},
    getConfiguredProvider: (id: string | undefined) => providers.find((entry) => entry.id === id),
    listProviders: () => providers,
    resolveProviderConfig: ({ rawConfig }: { rawConfig: Record<string, unknown> }) => rawConfig,
    isProviderConfigured: ({ provider }: { provider: TestProvider }) =>
      provider.configured === true,
  };

  it("keeps legacy selection compatible while warning once with the awaited replacement", async () => {
    const warning = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
    try {
      await withPluginRuntimePluginScope(
        { pluginId: "provider-selection-diagnostic" },
        async () => {
          expect(await resolveConfiguredCapabilityProviderAsync(params)).toMatchObject({
            ok: true,
            provider: { id: "second" },
          });
          expect(warning).not.toHaveBeenCalled();
          for (let use = 0; use < 2; use += 1) {
            expect(resolveConfiguredCapabilityProvider(params)).toMatchObject({
              ok: true,
              provider: { id: "second" },
            });
          }
        },
      );
      expect(warning).toHaveBeenCalledExactlyOnceWith(
        expect.stringContaining("await resolveConfiguredCapabilityProviderAsync()"),
        { code: "DEP_PLUGIN_SDK", type: "DeprecationWarning" },
      );
    } finally {
      warning.mockRestore();
    }
  });

  it("preserves JSON config keys without invoking prototype setters", () => {
    const rawConfig = JSON.parse('{"__proto__":{"marker":"config-value"},"constructor":"literal"}');
    const resolved = resolveProviderRawConfig({
      providerId: "canonical",
      providerConfigs: { canonical: rawConfig },
    });

    expect(Object.getPrototypeOf(resolved)).toBe(Object.prototype);
    expect(Object.hasOwn(resolved, "__proto__")).toBe(true);
    expect(resolved).toEqual(rawConfig);
  });

  it("selects an explicit provider when it exists", () => {
    const selection = selectConfiguredOrAutoProvider({
      ...params,
      configuredProviderId: " second ",
    });

    expect(selection).toEqual({
      configuredProviderId: "second",
      missingConfiguredProvider: false,
      provider: providers[1],
    });
  });

  it("reports a missing explicit provider", () => {
    const resolution = resolveConfiguredCapabilityProvider({
      ...params,
      configuredProviderId: "missing",
    });

    expect(resolution).toEqual({
      ok: false,
      code: "missing-configured-provider",
      configuredProviderId: "missing",
    });
  });

  it("auto-selects the first configured provider by order", () => {
    const resolution = resolveConfiguredCapabilityProvider({
      ...params,
      resolveProviderConfig: ({ provider, rawConfig }) => ({
        ...rawConfig,
        providerId: provider.id,
      }),
      isProviderConfigured: ({ providerConfig }) => providerConfig.providerId === "second",
    });

    expect(resolution).toEqual({
      ok: true,
      configuredProviderId: undefined,
      provider: providers[1],
      providerConfig: { providerId: "second" },
    });
    expect(resolution.provider).toBe(providers[1]);
  });

  it("retains the first unavailable provider when no auto candidate is available", () => {
    const resolveProviderConfig = vi.fn();
    const resolution = resolveConfiguredCapabilityProvider({
      ...params,
      isProviderAvailable: () => false,
      resolveProviderConfig,
      isProviderConfigured: () => true,
    });

    expect(resolution).toEqual({
      ok: false,
      code: "provider-unavailable",
      provider: providers[0],
    });
    expect(resolveProviderConfig).not.toHaveBeenCalled();
  });

  it("merges provider config with explicit alias selection", () => {
    expect(
      resolveProviderRawConfig({
        providerId: "canonical",
        providerAliases: ["alias", "other-alias"],
        configuredProviderId: "other-alias",
        providerConfigs: {
          canonical: { apiKey: "default", model: "base" },
          "other-alias": { model: "other-model", voice: "second", language: "en" },
          alias: { model: "alias-model", voice: "first" },
        },
      }),
    ).toEqual({ apiKey: "default", model: "other-model", voice: "second", language: "en" });
  });
});
