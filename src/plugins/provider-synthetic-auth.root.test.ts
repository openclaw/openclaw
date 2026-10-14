import { expect, it } from "vitest";
import type { ProviderPlugin } from "./provider-plugin.types.js";
import { prepareSyntheticAuthWithProvider } from "./provider-synthetic-auth.js";

it("resolves native dependencies from the loader-owned plugin root", async () => {
  const provider: ProviderPlugin = {
    id: "native",
    label: "Native",
    auth: [],
    pluginRoot: "/plugins/native-package",
    async prepareSyntheticAuth({ pluginRoot }) {
      return pluginRoot
        ? { apiKey: "native-presence", mode: "api-key", source: pluginRoot }
        : undefined;
    },
  };
  expect(
    await prepareSyntheticAuthWithProvider(provider, { config: {}, provider: "native" }),
  ).toMatchObject({
    source: "/plugins/native-package",
  });
});
