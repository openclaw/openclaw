// Covers classifying the memory slot owner from owners this process already loaded.
import { afterEach, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  getMemoryProviderRuntime,
  resolveLoadedMemoryProviderKind,
  setStandaloneMemoryOwner,
} from "./memory-state.js";
import type { MemoryPluginCapability } from "./registry-contribution-types.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";
import { clearActivePluginRegistry, setActivePluginRegistry } from "./runtime.js";
import { withPluginRuntimeRegistryScope } from "./runtime/gateway-request-scope.js";

const knowledgeSlot: OpenClawConfig = { plugins: { slots: { memory: "knowledge" } } };
const nativeCapability: MemoryPluginCapability = {
  providerRuntime: { open: async () => ({ provider: null }) },
};
const legacyCapability: MemoryPluginCapability = {
  runtime: {
    getMemorySearchManager: async () => ({ manager: null }),
    resolveMemoryBackendConfig: () => ({ backend: "builtin" as const }),
  },
};

function registryWith(pluginId: string, capability: MemoryPluginCapability) {
  const registry = createEmptyPluginRegistry();
  registry.memoryCapabilities.push({ pluginId, capability, memorySlotSelected: true });
  return registry;
}

// A run-scoped registry without memory registrations is the cold context.
function inColdRun<T>(run: () => T): T {
  return withPluginRuntimeRegistryScope(createEmptyPluginRegistry(), run);
}

afterEach(async () => {
  setStandaloneMemoryOwner(undefined);
  await clearActivePluginRegistry();
});

it("finds the configured native slot owner in the process registry from a cold run", () => {
  setActivePluginRegistry(registryWith("knowledge", nativeCapability));

  // The run's own registry has no memory owner, so a registry-only check misses it.
  expect(inColdRun(() => getMemoryProviderRuntime())).toBeUndefined();
  expect(inColdRun(() => resolveLoadedMemoryProviderKind(knowledgeSlot))).toBe("native");
  // A process owner answers only for the slot the config selects.
  expect(
    inColdRun(() => resolveLoadedMemoryProviderKind({ plugins: { slots: { memory: "other" } } })),
  ).toBeUndefined();
});

it("finds a native slot owner that an earlier standalone lookup loaded", () => {
  setStandaloneMemoryOwner({ pluginId: "knowledge", native: true });

  expect(inColdRun(() => resolveLoadedMemoryProviderKind(knowledgeSlot))).toBe("native");
});

it("classifies loaded legacy owners as legacy and reports nothing when no owner is loaded", () => {
  expect(inColdRun(() => resolveLoadedMemoryProviderKind(knowledgeSlot))).toBeUndefined();

  setStandaloneMemoryOwner({ pluginId: "knowledge", native: false });
  expect(inColdRun(() => resolveLoadedMemoryProviderKind(knowledgeSlot))).toBe("legacy");

  setStandaloneMemoryOwner(undefined);
  setActivePluginRegistry(registryWith("knowledge", legacyCapability));
  expect(inColdRun(() => resolveLoadedMemoryProviderKind(knowledgeSlot))).toBe("legacy");
});

it("prefers the current registry's owner over process and standalone facts", () => {
  setStandaloneMemoryOwner({ pluginId: "knowledge", native: false });

  expect(
    withPluginRuntimeRegistryScope(registryWith("knowledge", nativeCapability), () =>
      resolveLoadedMemoryProviderKind(knowledgeSlot),
    ),
  ).toBe("native");
});
