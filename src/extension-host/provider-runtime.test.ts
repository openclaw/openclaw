import { describe, expect, it } from "vitest";
import { createEmptyPluginRegistry } from "../plugins/registry.js";
import { resolveExtensionHostProviders } from "./provider-runtime.js";
import { addExtensionHostProviderRegistration } from "./runtime-registry.js";

describe("resolveExtensionHostProviders", () => {
  it("projects provider registrations into provider plugins with plugin ids", () => {
    const registry = createEmptyPluginRegistry();
    addExtensionHostProviderRegistration(registry, {
      pluginId: "demo-plugin",
      source: "bundled",
      provider: {
        id: "demo-provider",
        label: "Demo Provider",
        auth: [],
      },
    });

    expect(resolveExtensionHostProviders({ registry })).toEqual([
      {
        id: "demo-provider",
        label: "Demo Provider",
        auth: [],
        pluginId: "demo-plugin",
      },
    ]);
  });
});
