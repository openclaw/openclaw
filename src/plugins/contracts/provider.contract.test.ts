import { afterAll, describe, expect, it } from "vitest";

const previousPreferDistPluginSdk = process.env.OPENCLAW_PLUGIN_SDK_PREFER_DIST;
process.env.OPENCLAW_PLUGIN_SDK_PREFER_DIST = "1";

const { providerContractLoadError, providerContractRegistry } = await import("./registry.js");
const { installProviderPluginContractSuite } = await import("./suites.js");

afterAll(() => {
  if (previousPreferDistPluginSdk === undefined) {
    delete process.env.OPENCLAW_PLUGIN_SDK_PREFER_DIST;
  } else {
    process.env.OPENCLAW_PLUGIN_SDK_PREFER_DIST = previousPreferDistPluginSdk;
  }
});

describe("provider contract registry load", () => {
  it("loads bundled providers without import-time registry failure", () => {
    expect(providerContractLoadError).toBeUndefined();
    expect(providerContractRegistry.length).toBeGreaterThan(0);
  });
});

for (const entry of providerContractRegistry) {
  describe(`${entry.pluginId}:${entry.provider.id} provider contract`, () => {
    installProviderPluginContractSuite({
      provider: entry.provider,
    });
  });
}
