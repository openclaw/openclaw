// Core asks every loaded provider plugin to normalize transports for providers without
// their own transport owner, so each hook must leave foreign transports untouched.
import { expect, it } from "vitest";
import { loadPluginManifestRegistryCore } from "../manifest-registry.js";
import { resolveProviderContractProvidersForPluginIds } from "./registry.js";

const foreign = {
  provider: "contract-foreign-provider",
  modelId: "vendor/model-1",
  api: "openai-completions",
  baseUrl: "https://api.contract-foreign.invalid/v1",
};

it("provider transport hooks leave other providers' transports untouched", () => {
  const pluginIds = loadPluginManifestRegistryCore({})
    .plugins.filter((plugin) => plugin.origin === "bundled" && (plugin.providers?.length ?? 0) > 0)
    .map((plugin) => plugin.id);
  const providers = resolveProviderContractProvidersForPluginIds(pluginIds);
  const hooked = providers.filter((provider) => provider.normalizeTransport);
  expect(hooked.length).toBeGreaterThan(0);
  const rewrites = hooked.flatMap((provider) => {
    const result = provider.normalizeTransport!(foreign);
    const changed =
      result &&
      ((result.api ?? foreign.api) !== foreign.api ||
        (result.baseUrl ?? foreign.baseUrl) !== foreign.baseUrl);
    return changed ? [`${provider.pluginId ?? provider.id}: ${JSON.stringify(result)}`] : [];
  });
  expect(rewrites).toEqual([]);
});
