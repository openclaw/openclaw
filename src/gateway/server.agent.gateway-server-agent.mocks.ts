import { vi } from "vitest";
import { createEmptyPluginRegistry, type PluginRegistry } from "../plugins/registry.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { setTestPluginRegistry } from "./test-helpers.mocks.js";

export const registryState: { registry: PluginRegistry } = {
  registry: createEmptyPluginRegistry(),
};

export function setRegistry(registry: PluginRegistry) {
  registryState.registry = registry;
  setTestPluginRegistry(registry);
  setActivePluginRegistry(registry);
}

vi.mock("./server-plugins.js", async () => {
  const { setActivePluginRegistry } = await import("../plugins/runtime.js");
  return {
    loadGatewayPlugins: (params: { baseMethods: string[] }) => {
      setActivePluginRegistry(registryState.registry);
      return {
        pluginRegistry: registryState.registry,
        gatewayMethods: params.baseMethods ?? [],
      };
    },
    // server.impl.ts sets a fallback context before dispatch; tests only need the symbol to exist.
    setFallbackGatewayContext: vi.fn(),
  };
});
