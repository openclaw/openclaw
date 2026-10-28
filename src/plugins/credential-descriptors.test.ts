import { beforeEach, expect, it, vi } from "vitest";
import { resolvePluginCredentialDescriptors as resolve } from "./credential-descriptors.js";
import type { PluginManifestRecord as Manifest } from "./manifest-registry.js";

const mocks = vi.hoisted(() => ({
  registry: vi.fn(),
  search: vi.fn(),
  fetch: vi.fn(),
  official: vi.fn(),
}));
vi.mock("./runtime/gateway-request-scope.js", () => ({
  getPluginRegistryForContext: mocks.registry,
}));
// mock-isolation: Synthetic provider metadata proves ownership without loading bundled plugins.
vi.mock("./web-provider-public-artifacts.explicit.js", () => ({
  resolveBundledExplicitWebSearchProvidersFromPublicArtifacts: mocks.search,
  resolveBundledExplicitWebFetchProvidersFromPublicArtifacts: mocks.fetch,
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
const id = "example";
const manifest = { id, origin: "global", contracts: { webSearchProviders: [id] } } as Manifest;
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
  expect(resolve(manifest)).toEqual([{ ...descriptor, ...metadata }]);
  expect(provider.getConfiguredCredentialValue).not.toHaveBeenCalled();
});

it.each([
  ["untrusted ID collision", "global", false, false],
  ["trusted official metadata", "global", true, true],
  ["bundled metadata", "bundled", false, true],
  ["missing bundled artifact", "bundled", false, false],
] as const)("discovers %s without activation", (_name, origin, trusted, available) => {
  mocks.search.mockReturnValue(available ? [{ ...provider, pluginId: id }] : null);
  expect(resolve({ ...manifest, origin, trustedOfficialInstall: trusted })).toEqual(
    available ? [descriptor] : [],
  );
  expect(provider.getConfiguredCredentialValue).not.toHaveBeenCalled();
  if (origin === "bundled") {
    expect(mocks.search).toHaveBeenCalledWith(expect.objectContaining({ onlyPluginIds: [id] }));
  }
  [
    ...(!trusted ? [mocks.official] : []),
    ...(origin === "bundled" ? [] : [mocks.search, mocks.fetch]),
  ].forEach((loader) => expect(loader).not.toHaveBeenCalled());
});
