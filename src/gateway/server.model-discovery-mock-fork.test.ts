import os from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { makeProviderModelFixture } from "../agents/test-helpers/provider-model-fixture.js";
import { agentDiscoveryMock } from "./test-helpers.js";

const agentDir = path.join(os.tmpdir(), "openclaw-model-discovery-mock-fork");

test("gateway model discovery forks keep routing through the harness", async () => {
  const { discoverModelsAsync } = await import("../agents/agent-model-discovery.js");
  const { AuthStorage } = await import("../agents/sessions/auth-storage.js");
  const registry = await discoverModelsAsync(AuthStorage.inMemory(), agentDir);
  const forked = registry.fork(AuthStorage.inMemory());
  expect(forked.getAll()).toEqual([]);
  expect(() => forked.getProviderMetadataOwners()).not.toThrow();
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

test("gateway model discovery resolves and preserves published provider rows", async () => {
  const model = makeProviderModelFixture<"openai-completions">({
    id: "forked-only",
    provider: "forked-provider",
    api: "openai-completions",
    baseUrl: "https://forked-provider.invalid/v1",
    contextWindow: 128_000,
  });
  agentDiscoveryMock.enabled = true;
  agentDiscoveryMock.models = [model];
  try {
    const { resolveModelAsync } = await import("../agents/embedded-agent-runner/model.js");
    const resolved = await resolveModelAsync("forked-provider", "forked-only", agentDir, {});
    expect(resolved.error).toBeUndefined();
    expect(resolved.model).toMatchObject({ provider: "forked-provider", id: "forked-only" });
    expect(resolved.modelRegistry?.getAll()).toEqual([model]);

    const { AuthStorage } = await import("../agents/sessions/auth-storage.js");
    const publishedModel = { ...model, contextWindow: 16_384 };
    const untouchedModel = { ...model, provider: "untouched-provider" };
    agentDiscoveryMock.models = [model, untouchedModel];
    const published = resolved
      .modelRegistry!.fork(AuthStorage.inMemory(), new Map([[model.provider, [publishedModel]]]))
      .fork(AuthStorage.inMemory());

    const updatedUntouchedModel = { ...untouchedModel, name: "Updated fixture" };
    agentDiscoveryMock.models = [model, updatedUntouchedModel];
    expect(published.find(model.provider, model.id)).toEqual(publishedModel);
    expect(published.getAll()).toEqual([updatedUntouchedModel, publishedModel]);
    expect(published.getAvailable()).toEqual([updatedUntouchedModel, publishedModel]);

    const removed = published.fork(AuthStorage.inMemory(), new Map([[model.provider, []]]));
    expect(removed.find(model.provider, model.id)).toBeUndefined();
    expect(removed.getAll()).toEqual([updatedUntouchedModel]);
    expect(removed.getAvailable()).toEqual([updatedUntouchedModel]);
  } finally {
    agentDiscoveryMock.enabled = false;
    agentDiscoveryMock.models = [];
  }
});
