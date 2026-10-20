import { beforeEach, expect, it, vi } from "vitest";
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
  getConfiguredCredentialValue: vi.fn(),
};
const manifest = {
  id: "example",
  origin: "global",
  contracts: { webSearchProviders: ["example"] },
} as PluginManifestRecord;
const descriptor = {
  path: ["plugins", "entries", "example", "config", "key"],
  label: "Example key",
  envVars: ["EXAMPLE_KEY"],
};
beforeEach(() => {
  vi.clearAllMocks();
  mocks.registry.mockReturnValue(undefined);
  mocks.official.mockReturnValue([{ pluginId: "example", provider }]);
});

it("promotes only owned declared credential paths once, preserving provider metadata", () => {
  const metadata = { placeholder: "example-…", signupUrl: "https://example.com/keys" };
  const declared = { ...provider, ...metadata };
  mocks.registry.mockReturnValue({
    webSearchProviders: [
      declared,
      declared,
      ...[
        "gateway.auth.token",
        "plugins.entries.other.config.key",
        "plugins.entries.example.config.__proto__.key",
        "",
      ].map((credentialPath) => Object.assign({}, declared, { credentialPath })),
    ].map((entry) => ({ pluginId: "example", provider: entry })),
  });
  expect(resolvePluginCredentialDescriptors(manifest)).toEqual([{ ...descriptor, ...metadata }]);
  expect(provider.getConfiguredCredentialValue).not.toHaveBeenCalled();
});

it.each([
  ["untrusted ID collision", "global", false, false],
  ["trusted official metadata", "global", true, true],
  ["bundled metadata", "bundled", false, true],
  ["missing bundled artifact", "bundled", false, false],
] as const)("discovers %s without activation", (_name, origin, trusted, available) => {
  mocks.bundledSearch.mockReturnValue(available ? [{ ...provider, pluginId: "example" }] : null);
  const selected = { ...manifest, origin, trustedOfficialInstall: trusted };
  expect(resolvePluginCredentialDescriptors(selected)).toEqual(available ? [descriptor] : []);
  expect(provider.getConfiguredCredentialValue).not.toHaveBeenCalled();
  if (origin === "bundled") {
    expect(mocks.bundledSearch).toHaveBeenCalledWith(
      expect.objectContaining({ onlyPluginIds: ["example"] }),
    );
  } else {
    expect(mocks.bundledSearch).not.toHaveBeenCalled();
    expect(mocks.bundledFetch).not.toHaveBeenCalled();
  }
  if (!trusted) {
    expect(mocks.official).not.toHaveBeenCalled();
  }
});
