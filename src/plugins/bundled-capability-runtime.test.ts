// Verifies bundled capability runtime registration from plugin metadata.
import { describe, expect, it } from "vitest";
import {
  buildVitestCapabilityShimAliasMap,
  loadBundledCapabilityRuntimeRegistry,
} from "./bundled-capability-runtime.js";

describe("buildVitestCapabilityShimAliasMap", () => {
  it("keeps scoped and unscoped capability shim aliases aligned", () => {
    const aliasMap = buildVitestCapabilityShimAliasMap();

    expect(aliasMap["openclaw/plugin-sdk/config-runtime"]).toBe(
      aliasMap["@openclaw/plugin-sdk/config-runtime"],
    );
    expect(aliasMap["openclaw/plugin-sdk/media-runtime"]).toBe(
      aliasMap["@openclaw/plugin-sdk/media-runtime"],
    );
    expect(aliasMap["openclaw/plugin-sdk/provider-onboard"]).toBe(
      aliasMap["@openclaw/plugin-sdk/provider-onboard"],
    );
    expect(aliasMap["openclaw/plugin-sdk/speech-core"]).toBe(
      aliasMap["@openclaw/plugin-sdk/speech-core"],
    );
  });
});

describe("loadBundledCapabilityRuntimeRegistry", () => {
  it("preserves manifest contracts for bundled capability plugins", () => {
    const registry = loadBundledCapabilityRuntimeRegistry({
      pluginIds: ["memory-core"],
      env: { ...process.env, VITEST: "1" },
      pluginSdkResolution: "dist",
    });

    const plugin = registry.plugins.find((entry) => entry.id === "memory-core");
    expect(plugin?.contracts).toEqual({
      tools: ["memory_get", "memory_search"],
    });
  });
});
