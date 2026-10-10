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
import { getPluginValueInstance } from "../plugins/plugin-instance-scope.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.types.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { getPluginSetupModuleLoader } from "../plugins/plugin-setup-module.js";
import type { GatewayRequestHandlerOptions } from "./server-methods/types.js";
import type { RecoveryFixtureFactory } from "./server-plugin-reload.recovery.test-support.js";

export async function verifySharedGatewayCacheOwnership(
  createRecoveryFixture: RecoveryFixtureFactory,
  rootDir: string,
  setMetadataLoader: (load: () => PluginMetadataSnapshot) => void,
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
    const retainedRecord = first.registryOwner.registry.plugins.find(
      (record) => record.id === "sibling",
    );
    assert(retainedRecord);
    const retainedHandler = first.registryOwner.registry.gatewayHandlers["sibling.setup"];
    await first.reload(config, ["first"]);
    expect(originalOwner.lifecycle.signal.aborted).toBe(false);
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
    await first.reload(config, ["sibling"]);
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
