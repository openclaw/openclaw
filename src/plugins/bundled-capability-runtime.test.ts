import { describe, expect, it } from "vitest";
import {
  buildVitestCapabilityShimAliasMap,
  loadBundledCapabilityRuntimeRegistry,
} from "./bundled-capability-runtime.js";

describe("buildVitestCapabilityShimAliasMap", () => {
  it("keeps scoped and unscoped capability shim aliases aligned", () => {
    const aliasMap = buildVitestCapabilityShimAliasMap();

    expect(aliasMap["openclaw/plugin-sdk/llm-task"]).toBe(
      aliasMap["@openclaw/plugin-sdk/llm-task"],
    );
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
  it("captures bundled migration providers", () => {
    const registry = loadBundledCapabilityRuntimeRegistry({
      pluginIds: ["migrate-hermes"],
      pluginSdkResolution: "dist",
    });

    const record = registry.plugins.find((entry) => entry.id === "migrate-hermes");
    expect(record?.migrationProviderIds).toEqual(["hermes"]);
    expect(
      registry.migrationProviders.map((entry) => ({
        pluginId: entry.pluginId,
        providerId: entry.provider.id,
      })),
    ).toEqual([{ pluginId: "migrate-hermes", providerId: "hermes" }]);
  });
});
