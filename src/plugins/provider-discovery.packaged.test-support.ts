import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  bindPluginMetadataSnapshotCache,
  createPluginCache,
  retirePluginCache,
  withPluginCache,
} from "./plugin-cache.js";
import { bindPluginInstanceModuleLoader } from "./plugin-instance-module-loader.js";
import { PluginInstance } from "./plugin-instance.js";
import { createPluginMetadataSnapshotFixture } from "./plugin-metadata.test-support.js";
import { resolvePluginDiscoveryProvidersRuntime } from "./provider-discovery.runtime.js";
import { prepareSyntheticAuthWithProvider } from "./provider-synthetic-auth.js";
import { writeArtifacts } from "./public-surface.test-support.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";
import { withPluginRuntimeGenerationScope } from "./runtime/generation-scope.js";
import { createPluginRecord } from "./status.test-helpers.js";

export const packagedDiscoveryProbePath = fileURLToPath(import.meta.url);

// Warm the public lazy import before measuring so loading the facade itself cannot
// satisfy the scheduling assertion. Each operation gets a fresh external source owner.
async function runAsyncDiscoverySchedulingProbe(root: string) {
  const { planRuntimePluginDiscovery, resolveRuntimePluginDiscoveryProviders } =
    await import("./provider-discovery.js");
  const { prepareProviderSyntheticAuthWithPlugin } = await import("./provider-runtime.js");
  for (const operation of ["plan", "resolve", "auth"] as const) {
    const id = "async-discovery-" + operation;
    const rootDir = path.join(root, id);
    const source = path.join(rootDir, "provider-discovery.cjs");
    const marker = Symbol.for(id);
    writeArtifacts(rootDir, {
      "package.json": { name: id, type: "commonjs" },
      "index.cjs": "module.exports = {};",
      "provider-discovery.cjs": `const scheduling = globalThis[Symbol.for(${JSON.stringify(id)})] ? "yielded" : "blocked";
module.exports = {
  id: ${JSON.stringify(id)}, label: scheduling, auth: [],
  staticCatalog: { order: "simple", run() { return { providers: {} }; } },
  async prepareSyntheticAuth() {
    return { apiKey: "fixture-" + scheduling, source: "fixture", mode: "oauth" };
  }
};`,
    });
    await using cache = createPluginCache();
    const snapshot = createPluginMetadataSnapshotFixture({
      plugins: [
        {
          id,
          rootDir,
          source: path.join(rootDir, "index.cjs"),
          origin: "config",
          providers: [id],
          providerDiscoverySource: source,
        },
      ],
    });
    bindPluginMetadataSnapshotCache(snapshot, cache);
    const config = { plugins: { allow: [id] } };
    const params = {
      config,
      env: {},
      onlyPluginIds: [id],
      pluginMetadataSnapshot: snapshot,
      discoveryEntriesOnly: true,
      includeSyntheticAuthProviders: true,
    };
    await withPluginCache(cache, () =>
      planRuntimePluginDiscovery({ ...params, onlyPluginIds: [] }),
    );
    const scheduled = setImmediate(() => Reflect.set(globalThis, marker, true));
    try {
      const observed = await withPluginCache(cache, () =>
        withPluginRuntimeGenerationScope({ metadataSnapshot: snapshot }, async () => {
          if (operation === "plan") {
            const plan = await planRuntimePluginDiscovery(params);
            assert.equal(plan.kind, "entries");
            assert.equal(plan.providers.length, 1);
            return plan.providers[0]?.label;
          }
          if (operation === "resolve") {
            const providers = await resolveRuntimePluginDiscoveryProviders(params);
            assert.equal(providers.length, 1);
            return providers[0]?.label;
          }
          const auth = await prepareProviderSyntheticAuthWithPlugin({
            provider: id,
            config,
            env: {},
            context: { config, provider: id },
          });
          return auth?.apiKey;
        }),
      );
      assert.equal(observed, operation === "auth" ? "fixture-yielded" : "yielded", operation);
    } finally {
      clearImmediate(scheduled);
      Reflect.deleteProperty(globalThis, marker);
      await retirePluginCache(cache);
    }
  }
}

// Keep SDK resolution outside Vitest's aliases while exposing the subprocess entrypoint.
if (process.argv[1] === packagedDiscoveryProbePath && process.argv[3] === "async-discovery") {
  await runAsyncDiscoverySchedulingProbe(process.argv[2]!);
} else if (process.argv[1] === packagedDiscoveryProbePath) {
  for (const active of [false, true]) {
    const name = active ? "active" : "inventory";
    const rootDir = path.join(process.argv[2]!, "dist", "extensions", name);
    const source = path.join(rootDir, "provider-discovery.mjs");
    const runtimeSource = path.join(rootDir, "index.mjs");
    writeArtifacts(rootDir, {
      "package.json": { name: "@openclaw/discovery-fixture", type: "module" },
      "index.mjs": "export default {};\n",
      "provider-discovery.mjs": `export default {
    id: "packaged-discovery", label: "Packaged discovery", auth: [],
    async prepareSyntheticAuth() {
      const { probe } = await import("./.setup/native-auth.mjs");
      return probe();
    }
  };`,
      ".setup/native-auth.mjs": `import { splitCommandArgs } from "openclaw/plugin-sdk/process-runtime";
  export const probe = () => ({
    apiKey: splitCommandArgs('synthetic "setup credential"').join(":"),
    source: "packaged fixture", mode: "api-key"
  });`,
    });
    await using cache = createPluginCache();
    const owner = {
      id: "packaged-discovery",
      rootDir,
      source: runtimeSource,
      origin: "bundled" as const,
    };
    const metadata = withPluginCache(cache, () =>
      createPluginMetadataSnapshotFixture({
        plugins: [{ ...owner, providers: [owner.id], providerDiscoverySource: source }],
      }),
    );
    const record = createPluginRecord(owner);
    const registry = { ...createEmptyPluginRegistry(), plugins: [record] };
    const runtime = new PluginInstance(record.id, { record, registry });
    try {
      if (active) {
        withPluginCache(cache, () =>
          bindPluginInstanceModuleLoader({ instance: runtime, ...owner }),
        );
        runtime.loadModule(runtimeSource);
      }
      const discover = () =>
        resolvePluginDiscoveryProvidersRuntime({
          config: {},
          env: {},
          onlyPluginIds: [owner.id],
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
      const read = () =>
        prepareSyntheticAuthWithProvider(provider, { config: {}, provider: owner.id });
      assert.equal((await read())?.apiKey, "synthetic:setup credential");
      await retirePluginCache(cache);
      await assert.rejects(read(), /reloaded|disabled|retir/);
    } finally {
      await runtime.dispose();
    }
  }
}
