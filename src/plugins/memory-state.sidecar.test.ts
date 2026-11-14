// Covers detecting a loaded memory sidecar from plugins this process already loaded.
import { afterEach, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { hasLoadedMemorySidecar } from "./memory-state.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";
import type { PluginRecord } from "./registry-types.js";
import { clearActivePluginRegistry, setActivePluginRegistry } from "./runtime.js";
import { withPluginRuntimeRegistryScope } from "./runtime/gateway-request-scope.js";

function config(entries: Record<string, boolean>, enabled = true): OpenClawConfig {
  return {
    plugins: {
      enabled,
      slots: { memory: "memory-core" },
      entries: Object.fromEntries(
        Object.entries(entries).map(([id, sidecar]) => [id, { memory: { sidecar } }]),
      ),
    },
  };
}

function registryWith(...records: Array<Pick<PluginRecord, "id" | "status" | "kind">>) {
  const registry = createEmptyPluginRegistry();
  registry.plugins.push(...records.map((record) => record as PluginRecord));
  return registry;
}

const memoryCore = { id: "memory-core", kind: "memory", status: "loaded" } as const;
const hindsight = { id: "hindsight-native", kind: "memory", status: "loaded" } as const;

afterEach(async () => {
  await clearActivePluginRegistry();
});

it("finds a loaded sidecar in the process registry from a cold run", () => {
  setActivePluginRegistry(registryWith(memoryCore, hindsight));

  expect(
    withPluginRuntimeRegistryScope(createEmptyPluginRegistry(), () =>
      hasLoadedMemorySidecar(config({ "hindsight-native": true })),
    ),
  ).toBe(true);
});

it("ignores sidecars that are off, unloaded, not memory plugins, or the slot owner", () => {
  setActivePluginRegistry(registryWith(memoryCore, hindsight));
  expect(hasLoadedMemorySidecar(config({}))).toBe(false);
  expect(hasLoadedMemorySidecar(config({ "hindsight-native": false }))).toBe(false);
  expect(hasLoadedMemorySidecar(config({ "hindsight-native": true }, false))).toBe(false);
  expect(hasLoadedMemorySidecar(config({ "memory-core": true }))).toBe(false);

  setActivePluginRegistry(registryWith(memoryCore, { ...hindsight, status: "error" }));
  expect(hasLoadedMemorySidecar(config({ "hindsight-native": true }))).toBe(false);

  setActivePluginRegistry(registryWith(memoryCore, { ...hindsight, kind: "context-engine" }));
  expect(hasLoadedMemorySidecar(config({ "hindsight-native": true }))).toBe(false);
});
