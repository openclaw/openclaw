import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolvePluginCredentialDescriptors } from "./credential-descriptors.js";
import type { PluginManifestRecord } from "./manifest-registry.js";

const mocks = vi.hoisted(() => ({
  registry: vi.fn(),
  bundledSearch: vi.fn(),
  bundledFetch: vi.fn(),
  official: vi.fn(),
}));
vi.mock("./runtime/gateway-request-scope.js", () => ({
  getPluginRegistryForContext: mocks.registry,
}));
vi.mock("./web-provider-public-artifacts.explicit.js", () => ({
  resolveBundledExplicitWebSearchProvidersFromPublicArtifacts: mocks.bundledSearch,
  resolveBundledExplicitWebFetchProvidersFromPublicArtifacts: mocks.bundledFetch,
}));
vi.mock("./web-search-install-catalog.js", () => ({
  resolveWebSearchInstallCatalogEntries: mocks.official,
}));
const provider = {
  credentialPath: "plugins.entries.example.config.key",
  credentialLabel: "Example key",
  envVars: ["EXAMPLE_KEY"],
  getConfiguredCredentialValue: vi.fn(() => {
    throw new Error("must not execute");
  }),
};
const manifest = {
  id: "example",
  origin: "global",
  contracts: { webSearchProviders: ["example"] },
} as PluginManifestRecord;
beforeEach(() => {
  vi.clearAllMocks();
  mocks.registry.mockReturnValue(undefined);
  mocks.official.mockReturnValue([{ pluginId: "example", provider }]);
});

describe("nonactivating credential descriptor discovery", () => {
  it("projects concrete string capability inputs from installed manifest metadata", () => {
    expect(
      resolvePluginCredentialDescriptors({
        ...manifest,
        configContracts: {
          secretInputs: {
            paths: [{ path: "service.apiKey", expected: "string", ownerKind: "capability" }],
          },
        },
        configUiHints: { "service.apiKey": { label: "Service key", placeholder: "Paste key" } },
      }),
    ).toEqual([
      {
        path: ["plugins", "entries", "example", "config", "service", "apiKey"],
        label: "Service key",
        envVars: [],
        placeholder: "Paste key",
        storage: "protected",
      },
    ]);
    expect(mocks.registry).toHaveBeenCalledTimes(1);
    expect(provider.getConfiguredCredentialValue).not.toHaveBeenCalled();
  });

  it("does not promote wildcard, route, undeclared-type, or unsafe manifest paths", () => {
    expect(
      resolvePluginCredentialDescriptors({
        ...manifest,
        configContracts: {
          secretInputs: {
            paths: [
              { path: "accounts.*.key", expected: "string", ownerKind: "capability" },
              { path: "route.key", expected: "string", ownerKind: "route" },
              { path: "legacy.key", ownerKind: "capability" },
              { path: "__proto__.key", expected: "string", ownerKind: "capability" },
            ],
          },
        },
      }),
    ).toEqual([]);
  });
  it("upgrades a provider descriptor once while preserving its presentation metadata", () => {
    mocks.registry.mockReturnValue({ webSearchProviders: [{ pluginId: "example", provider }] });
    expect(
      resolvePluginCredentialDescriptors({
        ...manifest,
        configContracts: {
          secretInputs: {
            paths: [
              { path: "key", expected: "string", ownerKind: "capability" },
              { path: "key", expected: "string", ownerKind: "capability" },
            ],
          },
        },
      }),
    ).toEqual([
      {
        path: ["plugins", "entries", "example", "config", "key"],
        label: "Example key",
        envVars: ["EXAMPLE_KEY"],
        storage: "protected",
      },
    ]);
  });

  it("promotes only owned declared credential paths once, preserving provider metadata", () => {
    const declared = {
      ...provider,
      placeholder: "example-…",
      signupUrl: "https://example.com/keys",
    };
    mocks.registry.mockReturnValue({
      webSearchProviders: [
        { pluginId: "example", provider: declared },
        { pluginId: "example", provider: declared },
        ...[
          "gateway.auth.token",
          "plugins.entries.other.config.key",
          "plugins.entries.example.config.__proto__.key",
          "",
        ].map((credentialPath) => ({
          pluginId: "example",
          provider: { ...declared, credentialPath },
        })),
      ],
    });
    expect(resolvePluginCredentialDescriptors(manifest)).toEqual([
      {
        path: ["plugins", "entries", "example", "config", "key"],
        label: "Example key",
        envVars: ["EXAMPLE_KEY"],
        placeholder: "example-…",
        signupUrl: "https://example.com/keys",
      },
    ]);
    expect(provider.getConfiguredCredentialValue).not.toHaveBeenCalled();
  });

  it("does not assign official credentials to an untrusted id collision or load a disabled external plugin", () => {
    expect(resolvePluginCredentialDescriptors(manifest)).toEqual([]);
    expect(mocks.official).not.toHaveBeenCalled();
    expect(mocks.bundledSearch).not.toHaveBeenCalled();
    expect(mocks.bundledFetch).not.toHaveBeenCalled();
  });
  it("reads already registered metadata without calling credential callbacks", () => {
    mocks.registry.mockReturnValue({ webSearchProviders: [{ pluginId: "example", provider }] });
    expect(resolvePluginCredentialDescriptors(manifest)).toEqual([
      {
        path: ["plugins", "entries", "example", "config", "key"],
        label: "Example key",
        envVars: ["EXAMPLE_KEY"],
      },
    ]);
    expect(provider.getConfiguredCredentialValue).not.toHaveBeenCalled();
  });
  it("uses trusted official metadata without plugin activation, even when disabled", () => {
    expect(
      resolvePluginCredentialDescriptors({ ...manifest, trustedOfficialInstall: true }),
    ).toHaveLength(1);
    expect(provider.getConfiguredCredentialValue).not.toHaveBeenCalled();
  });
  it("exposes bundled credential metadata independently of runtime activation", () => {
    mocks.bundledSearch.mockReturnValue([{ ...provider, pluginId: "example" }]);
    expect(resolvePluginCredentialDescriptors({ ...manifest, origin: "bundled" })).toEqual([
      {
        path: ["plugins", "entries", "example", "config", "key"],
        label: "Example key",
        envVars: ["EXAMPLE_KEY"],
      },
    ]);
    expect(provider.getConfiguredCredentialValue).not.toHaveBeenCalled();
  });
  it("uses only the named bundled public artifact and does not fall through when absent", () => {
    mocks.bundledSearch.mockReturnValue(null);
    expect(resolvePluginCredentialDescriptors({ ...manifest, origin: "bundled" })).toEqual([]);
    expect(mocks.bundledSearch).toHaveBeenCalledWith(
      expect.objectContaining({ onlyPluginIds: ["example"] }),
    );
    expect(mocks.official).not.toHaveBeenCalled();
  });
});
