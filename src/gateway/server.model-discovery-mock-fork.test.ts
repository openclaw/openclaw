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

test("gateway model discovery stand-in resolves a model through the real prepared runtime", async () => {
  const model = {
    id: "forked-only",
    name: "Forked Only",
    provider: "forked-provider",
    api: "openai-completions" as const,
    baseUrl: "https://forked-provider.invalid/v1",
    reasoning: false,
    input: ["text" as const],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 4096,
  };
  agentDiscoveryMock.enabled = true;
  agentDiscoveryMock.models = [model];
  try {
    // No stores are passed, so the resolver prepares the model runtime itself: discovery
    // returns the stand-in, createStores forks it, and resolveExplicitModelWithRegistry
    // reads metadata owners and the model row from that fork.
    const { resolveModelAsync } = await import("../agents/embedded-agent-runner/model.js");
    const resolved = await resolveModelAsync("forked-provider", "forked-only", agentDir, {});

    expect(resolved.error).toBeUndefined();
    expect(resolved.model).toMatchObject({ provider: "forked-provider", id: "forked-only" });
    expect(Object.getPrototypeOf(resolved.modelRegistry)?.constructor?.name).toBe(
      "MockModelRegistry",
    );
  } finally {
    agentDiscoveryMock.enabled = false;
    agentDiscoveryMock.models = [];
  }
});
