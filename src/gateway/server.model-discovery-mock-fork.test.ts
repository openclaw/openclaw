// Pins the Gateway agent-model-discovery stand-in against the members the real
// prepared-model-runtime consumes. `createStores` in
// src/agents/prepared-model-runtime.full-catalog.ts forks the lifecycle-owned
// template registry once per run, so a stand-in without `fork` turns every
// Gateway test that reaches the real prepareModelChoice path into
// "templateModelRegistry.fork is not a function".
import os from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { agentDiscoveryMock } from "./test-helpers.js";

const agentDir = path.join(os.tmpdir(), "openclaw-model-discovery-mock-fork");

// The stand-in replaces the module, so resolve it after this file's mock wiring loads.
async function createStandInRegistry() {
  const { discoverModelsAsync } = await import("../agents/agent-model-discovery.js");
  const { AuthStorage } = await import("../agents/sessions/auth-storage.js");
  const registry = await discoverModelsAsync(AuthStorage.inMemory(), agentDir);
  expect(Object.getPrototypeOf(registry)?.constructor?.name).toBe("MockModelRegistry");
  return { registry, AuthStorage };
}

test("gateway model discovery stand-in forks a registry the prepared runtime can use", async () => {
  const { registry, AuthStorage } = await createStandInRegistry();
  const forked = registry.fork(AuthStorage.inMemory());

  expect(Object.getPrototypeOf(forked)?.constructor?.name).toBe("MockModelRegistry");
  expect(forked.getAll()).toEqual([]);
  expect(() => forked.getProviderMetadataOwners()).not.toThrow();
});

test("gateway model discovery stand-in keeps forked registries routed through the harness", async () => {
  const { registry, AuthStorage } = await createStandInRegistry();
  const forked = registry.fork(AuthStorage.inMemory());
  const model = { id: "forked-only", name: "Forked Only", provider: "forked-provider" };

  agentDiscoveryMock.enabled = true;
  agentDiscoveryMock.models = [model];
  try {
    expect(forked.getAll()).toEqual([model]);
    expect(forked.find("forked-provider", "forked-only")).toEqual(model);
  } finally {
    agentDiscoveryMock.enabled = false;
    agentDiscoveryMock.models = [];
  }
});
