import { describe, expect, it } from "vitest";
import { providerContractLoadError, providerContractRegistry } from "./registry.js";
import { installProviderPluginContractSuite } from "./suites.js";

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
