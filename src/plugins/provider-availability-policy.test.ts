import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { resolveProviderManagesOwnAvailability } from "./provider-availability-policy.js";
import type { ProviderPlugin } from "./provider-plugin.types.js";

let createEmptyPluginRegistry: typeof import("./registry-empty.js").createEmptyPluginRegistry;
let resetPluginRuntimeStateForTest: typeof import("./runtime.js").resetPluginRuntimeStateForTest;
let setActivePluginRegistry: typeof import("./runtime.js").setActivePluginRegistry;

describe("resolveProviderManagesOwnAvailability", () => {
  beforeAll(async () => {
    ({ createEmptyPluginRegistry } = await import("./registry-empty.js"));
    ({ resetPluginRuntimeStateForTest, setActivePluginRegistry } = await import("./runtime.js"));
  });

  afterEach(() => {
    resetPluginRuntimeStateForTest();
  });

  it("reads the bundled gateway declarations without provider runtime", () => {
    expect(resolveProviderManagesOwnAvailability({ provider: "openrouter" })).toBe(true);
    expect(resolveProviderManagesOwnAvailability({ provider: "Kilocode" })).toBe(true);
  });

  it("defaults to false for providers that never declared ownership", () => {
    expect(resolveProviderManagesOwnAvailability({ provider: "anthropic" })).toBe(false);
    expect(resolveProviderManagesOwnAvailability({ provider: "my-gateway" })).toBe(false);
    expect(resolveProviderManagesOwnAvailability({ provider: undefined })).toBe(false);
  });

  it("honors a loaded provider plugin that declares ownership", () => {
    const provider: ProviderPlugin = {
      id: "my-gateway",
      label: "My Gateway",
      auth: [],
      managesOwnAvailability: true,
    };
    const registry = createEmptyPluginRegistry();
    registry.providers.push({ pluginId: "my-gateway", provider, source: "test" });
    setActivePluginRegistry(registry, "startup-registry", "gateway-bindable", "/tmp/workspace");

    expect(resolveProviderManagesOwnAvailability({ provider: "My-Gateway" })).toBe(true);
    expect(resolveProviderManagesOwnAvailability({ provider: "other-gateway" })).toBe(false);
  });
});
