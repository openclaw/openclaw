import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createPluginCache, withPluginCache } from "./plugin-cache.js";
import { bindPluginInstanceModuleLoader } from "./plugin-instance-module-loader.js";
import { PluginInstance } from "./plugin-instance.js";
import { clearPluginMetadataLifecycleCaches } from "./plugin-metadata-lifecycle.js";
import { createPluginMetadataSnapshotFixture } from "./plugin-metadata.test-support.js";
import { resolveProviderModelPolicySurface } from "./provider-model-routes.js";
import { createTestPluginRegistry } from "./registry-runtime.test-helpers.js";
import { withPluginRuntimeRegistryScope } from "./runtime/gateway-request-scope.js";
import { createPluginRecord } from "./status.test-helpers.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

beforeEach(() => {
  vi.resetModules();
  clearPluginMetadataLifecycleCaches();
});

it("keeps a missing policy absent in its captured owner", async () => {
  const rootDir = tempDirs.make("openclaw-provider-policy-probes-");
  const source = path.join(rootDir, "index.js");
  const policyPath = path.join(rootDir, "provider-policy-api.js");
  const pluginId = "captured-policy-probes";
  const owner = { id: pluginId, rootDir, source, origin: "global" as const };
  fs.writeFileSync(source, "export default {};\n");
  await using cache = createPluginCache();
  const builder = createTestPluginRegistry();
  const record = createPluginRecord(owner);
  builder.registry.plugins.push(record);
  const instance = new PluginInstance(record.id, { record, registry: builder.registry });
  try {
    const metadata = withPluginCache(cache, () => {
      bindPluginInstanceModuleLoader({ instance, ...owner });
      instance.run(() =>
        builder.createApi(record, { config: {} }).registerProvider({
          id: record.id,
          label: "Captured policy probes",
          auth: [],
        }),
      );
      return createPluginMetadataSnapshotFixture({
        plugins: [{ ...owner, providers: [pluginId] }],
      });
    });
    const read = () =>
      withPluginRuntimeRegistryScope(builder.registry, () =>
        withPluginCache(cache, () => resolveProviderModelPolicySurface(pluginId, metadata)),
      );
    expect(read()).toBeNull();

    fs.writeFileSync(
      policyPath,
      'export function normalizeModelCatalogId() { return "replacement-model"; }\n',
    );
    expect(read()).toBeNull();
  } finally {
    await instance.dispose();
  }
});
