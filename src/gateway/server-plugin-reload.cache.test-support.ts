import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { expect, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { setGatewayPluginMetadataSnapshot } from "../plugins/current-plugin-metadata-snapshot.js";
import {
  createPluginCache,
  getPluginMetadataSnapshotCache,
  withPluginCache,
} from "../plugins/plugin-cache.js";
import { getPluginInstance, getPluginValueInstance } from "../plugins/plugin-instance-scope.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.types.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { getPluginSetupModuleLoader } from "../plugins/plugin-setup-module.js";
import type { GatewayRequestHandlerOptions } from "./server-methods/types.js";
import type { RecoveryFixtureFactory } from "./server-plugin-reload.recovery.test-support.js";

export async function verifyGatewayCacheOwnership(
  createRecoveryFixture: RecoveryFixtureFactory,
  rootDir: string,
  setMetadataLoader: (load: () => PluginMetadataSnapshot) => void,
) {
  const source = path.join(rootDir, "setup.cjs");
  const dependency = path.join(rootDir, "lazy.mjs");
  await fs.writeFile(dependency, 'export const value = "captured";');
  await fs.writeFile(source, 'module.exports = async () => (await import("./lazy.mjs")).value;');
  const loadMetadata = () =>
    Object.assign(
      createPluginMetadataSnapshotFixture({
        plugins: [
          { id: "first", origin: "config", rootDir, source, setupSource: source },
          { id: "sibling" },
        ],
      }),
      { discovery: { candidates: [], diagnostics: [] } },
    );
  setMetadataLoader(loadMetadata);
  const config: OpenClawConfig = { plugins: { allow: ["first", "sibling"] } };
  const initialCache = createPluginCache();
  const initial = withPluginCache(initialCache, loadMetadata);
  setGatewayPluginMetadataSnapshot(initial, { config, env: {} });
  const first = await createRecoveryFixture({
    config,
    pluginMetadataSnapshot: initial,
    abortOnCandidateStart: false,
  });
  const second = await createRecoveryFixture({
    config,
    pluginMetadataSnapshot: initial,
    abortOnCandidateStart: false,
  });
  // Startup reuses the current boot inventory; only the reloading Gateway advances it.
  try {
    await first.reload();
    const metadata = first.runtime.pluginMetadataSnapshot;
    assert(metadata);
    const cache = getPluginMetadataSnapshotCache(metadata);
    expect(cache).not.toBe(initialCache);
    expect(second.runtime.pluginMetadataSnapshot).toBe(initial);
    const record = metadata.manifestRegistry.plugins.find((plugin) => plugin.id === "first");
    assert(record);
    const callback = withPluginCache(cache, () =>
      getPluginSetupModuleLoader(record, source, rootDir)(source),
    );
    assert(typeof callback === "function");
    const callbackOwner = getPluginValueInstance(callback);
    assert(callbackOwner);
    const firstRegistry = first.registryOwner.registry;
    const firstInstance = getPluginInstance(firstRegistry.plugins[0]!);
    assert(firstInstance);
    await fs.writeFile(dependency, 'export const value = "edited after capture";');

    await second.reload();
    expect(first.registryOwner.registry).toBe(firstRegistry);
    expect(firstInstance.run(() => "live")).toBe("live");
    expect(callbackOwner.lifecycle.signal.aborted).toBe(false);
    await expect(callback()).resolves.toBe("captured");

    await first.reload();
    expect(callbackOwner.lifecycle.signal.aborted).toBe(true);
    expect(() => callback()).toThrow("reloaded or disabled");
  } finally {
    // The enclosing fixture closes registry and metadata owners in lifecycle order.
    await Promise.all([
      first.runtime.kernel.pluginMetadata.waitForRetirement(),
      second.runtime.kernel.pluginMetadata.waitForRetirement(),
    ]);
  }
}

export async function verifySharedGatewayCacheOwnership(
  createRecoveryFixture: RecoveryFixtureFactory,
  rootDir: string,
  setMetadataLoader: (load: () => PluginMetadataSnapshot) => void,
  mode: "lookup" | "replacement",
) {
  const source = path.join(rootDir, "setup.cjs");
  const dependency = path.join(rootDir, "lazy.mjs");
  const writeSetup = (name: string) =>
    fs.writeFile(
      source,
      `module.exports = async function ${name}() { return (await import("./lazy.mjs")).value; };`,
    );
  await fs.writeFile(dependency, 'export const value = "captured";');
  await writeSetup("initial");
  const loadMetadata = () =>
    Object.assign(
      createPluginMetadataSnapshotFixture({
        plugins: [
          { id: "first" },
          { id: "sibling", origin: "config", rootDir, source, setupSource: source },
        ],
      }),
      { discovery: { candidates: [], diagnostics: [] } },
    );
  setMetadataLoader(loadMetadata);
  const config: OpenClawConfig = { plugins: { allow: ["first", "sibling"] } };
  const initialCache = createPluginCache();
  const initial = withPluginCache(initialCache, loadMetadata);
  const manifest = initial.manifestRegistry.plugins.find((record) => record.id === "sibling");
  assert(manifest);
  const loadCallback = () => {
    const callback = getPluginSetupModuleLoader(manifest, source, rootDir)(source);
    assert(typeof callback === "function");
    return callback;
  };
  setGatewayPluginMetadataSnapshot(initial, { config, env: {} });
  const callbacks: Array<ReturnType<typeof loadCallback>> = [];
  const options: NonNullable<Parameters<RecoveryFixtureFactory>[0]> = {
    config,
    pluginMetadataSnapshot: initial,
    abortOnCandidateStart: false,
    register: (api, owner) => {
      if (owner === "sibling") {
        const callback = loadCallback();
        callbacks.push(callback);
        api.registerGatewayMethod("sibling.setup", async ({ respond }) => {
          respond(true, { value: await callback() }, undefined);
        });
      }
    },
  };
  const first = await createRecoveryFixture(options);
  const second = await createRecoveryFixture(options);
  const original = callbacks[0];
  assert(original);
  expect(callbacks[1]).toBe(original);
  const originalOwner = getPluginValueInstance(original);
  assert(originalOwner);
  const probe = async (fixture: Awaited<ReturnType<RecoveryFixtureFactory>>, expected: string) => {
    const respond = vi.fn();
    const handler = fixture.registryOwner.registry.gatewayHandlers["sibling.setup"];
    assert(handler);
    await handler({
      req: { type: "req", id: "shared-setup-probe", method: "sibling.setup" },
      params: {},
      client: null,
      isWebchatConnect: () => false,
      respond,
      context: {} as GatewayRequestHandlerOptions["context"],
    });
    expect(respond).toHaveBeenCalledExactlyOnceWith(
      true,
      { value: expected },
      undefined,
      undefined,
    );
  };
  try {
    await fs.writeFile(dependency, 'export const value = "edited after capture";');
    await writeSetup("replacement");
    const retained = mode === "lookup" ? first : second;
    const retainedRecord = retained.registryOwner.registry.plugins.find(
      (record) => record.id === "sibling",
    );
    assert(retainedRecord);
    const retainedHandler = retained.registryOwner.registry.gatewayHandlers["sibling.setup"];
    await first.reload(config, [mode === "lookup" ? "first" : "sibling"]);
    expect(originalOwner.lifecycle.signal.aborted).toBe(false);
    if (mode === "lookup") {
      // B still owns S0/C0: a fresh lookup must reach that same captured setup graph.
      const metadata = second.runtime.pluginMetadataSnapshot;
      assert(metadata);
      const lookup = withPluginCache(getPluginMetadataSnapshotCache(metadata), loadCallback);
      expect(lookup).toBe(original);
      await second.reload(config, ["sibling"]);
      expect(first.registryOwner.registry.plugins).toContain(retainedRecord);
      expect(first.registryOwner.registry.gatewayHandlers["sibling.setup"]).toBe(retainedHandler);
      await probe(first, "captured");
      expect(originalOwner.lifecycle.signal.aborted).toBe(false);
    } else {
      await probe(second, "captured");
    }
    await retained.reload(config, ["sibling"]);
    expect(originalOwner.lifecycle.signal.aborted).toBe(true);
    expect(() => original()).toThrow("reloaded or disabled");
    await probe(first, "edited after capture");
    await probe(second, "edited after capture");
  } finally {
    // The enclosing fixture closes registry and metadata owners in lifecycle order.
    await Promise.all([
      first.runtime.kernel.pluginMetadata.waitForRetirement(),
      second.runtime.kernel.pluginMetadata.waitForRetirement(),
    ]);
  }
}
