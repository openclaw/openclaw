// Verifies the pure registry-merge helper used by scoped harness loads to
// preserve already-active plugins (openclaw/openclaw#107408) without
// re-registering them.
import { describe, expect, it } from "vitest";
import { createEmptyPluginRegistry } from "./registry-empty.js";
import { mergeMissingPluginRegistryInto } from "./registry-scoped-merge.js";
import type { PluginRegistry } from "./registry-types.js";

function registryWithPlugin(pluginId: string, cliBackendId = `${pluginId}-cli`): PluginRegistry {
  const registry = createEmptyPluginRegistry();
  registry.plugins.push({
    id: pluginId,
    name: pluginId,
    source: `${pluginId}.js`,
    origin: "workspace",
    enabled: true,
    status: "loaded",
  } as never);
  registry.cliBackends.push({
    pluginId,
    backend: { id: cliBackendId } as never,
    source: `${pluginId}.js`,
  } as never);
  registry.workerProviders.set(`${pluginId}-worker`, {
    pluginId,
    provider: { id: `${pluginId}-worker` } as never,
    source: `${pluginId}.js`,
  } as never);
  registry.gatewayHandlers[`${pluginId}.method`] = (() => {}) as never;
  return registry;
}

describe("mergeMissingPluginRegistryInto", () => {
  it("copies the missing plugin's registrations into the target without touching existing ones", () => {
    const target = registryWithPlugin("already-active");
    const source = registryWithPlugin("newly-loaded");

    mergeMissingPluginRegistryInto(target, source, ["newly-loaded"]);

    expect(target.plugins.map((p) => p.id).toSorted()).toEqual(["already-active", "newly-loaded"]);
    expect(target.cliBackends.map((entry) => entry.pluginId).toSorted()).toEqual([
      "already-active",
      "newly-loaded",
    ]);
    expect([...target.workerProviders.keys()].toSorted()).toEqual([
      "already-active-worker",
      "newly-loaded-worker",
    ]);
    expect(Object.keys(target.gatewayHandlers).toSorted()).toEqual([
      "already-active.method",
      "newly-loaded.method",
    ]);
  });

  it("ignores source entries whose pluginId is not in missingPluginIds", () => {
    const target = registryWithPlugin("already-active");
    const source = registryWithPlugin("newly-loaded");
    // Source also carries an id outside the requested scope — must not leak in.
    source.plugins.push({
      id: "bystander",
      name: "bystander",
      source: "bystander.js",
      origin: "workspace",
      enabled: true,
      status: "loaded",
    } as never);
    source.cliBackends.push({
      pluginId: "bystander",
      backend: { id: "bystander-cli" } as never,
      source: "bystander.js",
    } as never);

    mergeMissingPluginRegistryInto(target, source, ["newly-loaded"]);

    expect(target.plugins.map((p) => p.id).toSorted()).toEqual(["already-active", "newly-loaded"]);
    expect(target.cliBackends.map((entry) => entry.pluginId)).not.toContain("bystander");
  });

  it("replaces a stale disabled/error record for the same plugin id instead of duplicating it", () => {
    const target = createEmptyPluginRegistry();
    target.plugins.push({
      id: "retry-me",
      name: "retry-me",
      source: "retry-me.js",
      origin: "workspace",
      enabled: false,
      status: "error",
      error: "boom",
    } as never);
    const source = registryWithPlugin("retry-me");

    mergeMissingPluginRegistryInto(target, source, ["retry-me"]);

    expect(target.plugins).toHaveLength(1);
    expect(target.plugins[0]?.status).toBe("loaded");
  });

  it("is a no-op for an empty missing-id list", () => {
    const target = registryWithPlugin("already-active");
    const source = registryWithPlugin("newly-loaded");

    mergeMissingPluginRegistryInto(target, source, []);

    expect(target.plugins.map((p) => p.id)).toEqual(["already-active"]);
  });

  it("does not duplicate a worker provider or gateway handler key already present in target", () => {
    const target = registryWithPlugin("newly-loaded");
    const source = registryWithPlugin("newly-loaded");

    mergeMissingPluginRegistryInto(target, source, ["newly-loaded"]);

    expect([...target.workerProviders.keys()]).toEqual(["newly-loaded-worker"]);
    expect(Object.keys(target.gatewayHandlers)).toEqual(["newly-loaded.method"]);
  });
});
