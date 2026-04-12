import { afterEach, describe, expect, it } from "vitest";
import type { PluginProviderRuntimeAuthOverrideRegistration } from "./registry-types.js";

async function importOverrideGlobalModule() {
  return import("./provider-runtime-auth-override-global.js");
}

function createOverride(pluginId: string): PluginProviderRuntimeAuthOverrideRegistration {
  return {
    pluginId,
    source: "test",
    override: {
      providers: ["openai"],
      run: async () => ({
        apiKey: `${pluginId}-key`,
        mode: "api-key",
      }),
    },
  };
}

afterEach(async () => {
  const mod = await importOverrideGlobalModule();
  mod.resetGlobalProviderRuntimeAuthOverridesForTest();
});

describe("provider-runtime-auth-override-global", () => {
  it("preserves override state across module reloads", async () => {
    const modA = await importOverrideGlobalModule();
    const overrides = [createOverride("persisted-plugin")];
    modA.setGlobalProviderRuntimeAuthOverrides(overrides);

    const modB = await importOverrideGlobalModule();

    expect(modB.getGlobalProviderRuntimeAuthOverrides()).toEqual(overrides);
  });

  it("resets override state for test isolation", async () => {
    const mod = await importOverrideGlobalModule();
    mod.setGlobalProviderRuntimeAuthOverrides([createOverride("teardown-plugin")]);

    mod.resetGlobalProviderRuntimeAuthOverridesForTest();

    expect(mod.getGlobalProviderRuntimeAuthOverrides()).toEqual([]);
  });

  it("hydrates malformed shared state to an empty override list", async () => {
    const stateKey = Symbol.for("openclaw.plugins.provider-runtime-auth-override-global-state");
    const globalStore = globalThis as Record<PropertyKey, unknown>;
    globalStore[stateKey] = undefined;

    const mod = await importOverrideGlobalModule();

    expect(mod.getGlobalProviderRuntimeAuthOverrides()).toEqual([]);
  });
});
