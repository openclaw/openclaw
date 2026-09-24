import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  getPluginMetadataSnapshotCache,
  retirePluginCache,
  withPluginCache,
} from "./plugin-cache.js";
import { bindPluginInstanceModuleLoader } from "./plugin-instance-module-loader.js";
import { PluginInstance } from "./plugin-instance.js";
import { createPluginMetadataSnapshotFixture } from "./plugin-metadata.test-support.js";
import { withPluginSourceCaptureDirectory } from "./plugin-package-metadata-capture.js";
import { resolvePluginDiscoveryProvidersRuntime } from "./provider-discovery.runtime.js";
import { resolveSyntheticAuthWithProvider } from "./provider-synthetic-auth.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";
import { withPluginRuntimeRegistryScope } from "./runtime/gateway-request-scope.js";
import { withPluginRuntimeGenerationRegistryScope } from "./runtime/generation-state.js";
import { createPluginRecord } from "./status.test-helpers.js";

const temp = useAutoCleanupTempDirTracker(afterEach);

it.each([true, false])(
  "keeps discovery with its exact source owner (selected runtime: %s)",
  async (selected) => {
    const rootDir = temp.make("provider-discovery-capture-");
    const captures = temp.make("provider-discovery-captures-");
    const id = "captured-discovery";
    const source = path.join(rootDir, "index.cjs");
    const discovery = path.join(rootDir, "provider-discovery.cjs");
    fs.writeFileSync(source, "module.exports = {};");
    const writeDiscovery = (value: string) =>
      fs.writeFileSync(
        discovery,
        `module.exports = {
    id: ${JSON.stringify(id)}, label: "Capture fixture", auth: [],
    resolveSyntheticAuth: () => ({ apiKey: ${JSON.stringify(value)}, source: "fixture", mode: "api-key" })
  };`,
      );
    writeDiscovery("synthetic-before");
    const metadata = createPluginMetadataSnapshotFixture({
      plugins: [
        {
          id,
          origin: "global",
          rootDir,
          source,
          providers: [id],
          providerDiscoverySource: discovery,
        },
      ],
    });
    const cache = getPluginMetadataSnapshotCache(metadata);
    const registry = createEmptyPluginRegistry();
    const record = createPluginRecord({ id, rootDir, source, origin: "global" });
    registry.plugins.push(record);
    const instance = new PluginInstance(id, { record, registry });
    try {
      withPluginSourceCaptureDirectory(captures, () =>
        withPluginCache(cache, () =>
          bindPluginInstanceModuleLoader({ instance, origin: "global", source, rootDir }),
        ),
      );
      instance.loadModule(source);
      writeDiscovery("synthetic-after");
      const providers = withPluginSourceCaptureDirectory(captures, () =>
        withPluginCache(cache, () =>
          withPluginRuntimeRegistryScope(registry, () =>
            withPluginRuntimeGenerationRegistryScope(
              selected ? registry : createEmptyPluginRegistry(),
              () =>
                resolvePluginDiscoveryProvidersRuntime({
                  config: { plugins: { allow: [id] } },
                  env: {},
                  onlyPluginIds: [id],
                  pluginMetadataSnapshot: metadata,
                  discoveryEntriesOnly: true,
                  includeSyntheticAuthProviders: true,
                }),
            ),
          ),
        ),
      );
      expect(providers).toHaveLength(1);
      const read = () =>
        resolveSyntheticAuthWithProvider(providers[0]!, { config: {}, provider: id });
      expect(read()?.apiKey).toBe(selected ? "synthetic-before" : "synthetic-after");
      await instance.dispose();
      if (selected) {
        expect(read).toThrow();
      } else {
        expect(read()?.apiKey).toBe("synthetic-after");
        await retirePluginCache(cache);
        expect(read).toThrow();
      }
    } finally {
      await instance.dispose();
      await retirePluginCache(cache);
    }
  },
);
