import { describe, expect, it } from "vitest";
import { webSearchProviderContractRegistry } from "./registry.js";
import { installWebSearchProviderContractSuite } from "./suites.js";

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
