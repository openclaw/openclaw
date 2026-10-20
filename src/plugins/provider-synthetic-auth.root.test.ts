import { expect, it } from "vitest";
import type { ProviderSyntheticAuthResult } from "./provider-external-auth.types.js";
import type { ProviderPlugin } from "./provider-plugin.types.js";
import { prepareSyntheticAuthWithProvider } from "./provider-synthetic-auth.js";

it("resolves native dependencies from the loader-owned plugin root", async () => {
  let prepared: ProviderSyntheticAuthResult | undefined;
  const provider: ProviderPlugin = {
    id: "native",
    label: "Native",
    auth: [],
    pluginRoot: "/plugins/native-package",
    async prepareSyntheticAuth({ pluginRoot }) {
      prepared = pluginRoot
        ? { apiKey: "native-presence", mode: "api-key", source: pluginRoot }
        : undefined;
      return prepared;
    },
  };
  const result = await prepareSyntheticAuthWithProvider(provider, {
    config: {},
    provider: "native",
  });
  expect(result).toMatchObject({
    source: "/plugins/native-package",
  });
  expect(result).toBe(prepared);
});
