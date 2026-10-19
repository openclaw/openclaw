import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPluginCache, retirePluginCache, withPluginCache } from "./plugin-cache.js";
import { bindPluginInstanceModuleLoader } from "./plugin-instance-module-loader.js";
import { PluginInstance } from "./plugin-instance.js";
import { createPluginMetadataSnapshotFixture } from "./plugin-metadata.test-support.js";
import { resolvePluginDiscoveryProvidersRuntime } from "./provider-discovery.runtime.js";
import { prepareSyntheticAuthWithProvider } from "./provider-synthetic-auth.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";
import { withPluginRuntimeGenerationScope } from "./runtime/generation-scope.js";
import { createPluginRecord } from "./status.test-helpers.js";

export const packagedDiscoveryProbePath = fileURLToPath(import.meta.url);

// Keep SDK resolution outside Vitest's aliases while exposing the subprocess entrypoint.
if (process.argv[1] === packagedDiscoveryProbePath) {
  for (const active of [false, true]) {
    const rootDir = path.join(
      process.argv[2]!,
      "dist",
      "extensions",
      active ? "active" : "inventory",
    );
    fs.mkdirSync(path.join(rootDir, ".setup"), { recursive: true });
    fs.writeFileSync(
      path.join(rootDir, "package.json"),
      JSON.stringify({ name: "@openclaw/discovery-fixture", type: "module" }),
    );
    const source = path.join(rootDir, "provider-discovery.mjs");
    const runtimeSource = path.join(rootDir, "index.mjs");
    fs.writeFileSync(runtimeSource, "export default {};\n");
    fs.writeFileSync(
      source,
      `export default {
    id: "packaged-discovery", label: "Packaged discovery", auth: [],
    async prepareSyntheticAuth() {
      const { probe } = await import("./.setup/native-auth.mjs");
      return probe();
    }
  };`,
    );
    fs.writeFileSync(
      path.join(rootDir, ".setup", "native-auth.mjs"),
      `import { splitCommandArgs } from "openclaw/plugin-sdk/process-runtime";
  export const probe = () => ({
    apiKey: splitCommandArgs('synthetic "setup credential"').join(":"),
    source: "packaged fixture", mode: "api-key"
  });`,
    );
    const cache = createPluginCache();
    const metadata = withPluginCache(cache, () =>
      createPluginMetadataSnapshotFixture({
        plugins: [
          {
            id: "packaged-discovery",
            rootDir,
            source: runtimeSource,
            providers: ["packaged-discovery"],
            providerDiscoverySource: source,
          },
        ],
      }),
    );
    const registry = createEmptyPluginRegistry();
    const record = createPluginRecord({
      id: "packaged-discovery",
      rootDir,
      source: runtimeSource,
      origin: "bundled",
    });
    registry.plugins.push(record);
    const runtime = new PluginInstance(record.id, { record, registry });
    try {
      if (active) {
        withPluginCache(cache, () =>
          bindPluginInstanceModuleLoader({
            instance: runtime,
            origin: "bundled",
            source: runtimeSource,
            rootDir,
          }),
        );
        runtime.loadModule(runtimeSource);
      }
      const discover = () =>
        resolvePluginDiscoveryProvidersRuntime({
          config: {},
          env: {},
          onlyPluginIds: ["packaged-discovery"],
          pluginMetadataSnapshot: metadata,
          discoveryEntriesOnly: true,
          includeSyntheticAuthProviders: true,
        });
      const providers = active
        ? withPluginRuntimeGenerationScope(
            { metadataSnapshot: metadata, pluginRegistry: registry },
            discover,
          )
        : discover();
      assert.equal(providers.length, 1);
      const provider = providers[0]!;
      assert.deepEqual(
        await prepareSyntheticAuthWithProvider(provider, { config: {}, provider: provider.id }),
        {
          apiKey: "synthetic:setup credential",
          source: "packaged fixture",
          mode: "api-key",
        },
      );
      await retirePluginCache(cache);
      await assert.rejects(
        prepareSyntheticAuthWithProvider(provider, { config: {}, provider: provider.id }),
        /reloaded|disabled|retir/,
      );
    } finally {
      await runtime.dispose();
      await retirePluginCache(cache);
    }
  }
}
