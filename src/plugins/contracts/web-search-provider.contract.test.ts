import { afterAll, describe, expect, it } from "vitest";

const previousPreferDistPluginSdk = process.env.OPENCLAW_PLUGIN_SDK_PREFER_DIST;
process.env.OPENCLAW_PLUGIN_SDK_PREFER_DIST = "1";

const { webSearchProviderContractRegistry } = await import("./registry.js");
const { installWebSearchProviderContractSuite } = await import("./suites.js");

afterAll(() => {
  if (previousPreferDistPluginSdk === undefined) {
    delete process.env.OPENCLAW_PLUGIN_SDK_PREFER_DIST;
  } else {
    process.env.OPENCLAW_PLUGIN_SDK_PREFER_DIST = previousPreferDistPluginSdk;
  }
});

describe("web search provider contract registry load", () => {
  it("loads bundled web search providers", () => {
    expect(webSearchProviderContractRegistry.length).toBeGreaterThan(0);
  });
});

for (const entry of webSearchProviderContractRegistry) {
  describe(`${entry.pluginId}:${entry.provider.id} web search contract`, () => {
    installWebSearchProviderContractSuite({
      provider: entry.provider,
      credentialValue: entry.credentialValue,
    });
  });
}
