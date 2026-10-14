import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createPluginCache, retirePluginCache, withPluginCache } from "./plugin-cache.js";
import { bindPluginInstanceModuleLoader } from "./plugin-instance-module-loader.js";
import { getPluginValueInstance } from "./plugin-instance-scope.js";
import { PluginInstance } from "./plugin-instance.js";
import { clearPluginMetadataLifecycleCaches } from "./plugin-metadata-lifecycle.js";
import { createPluginMetadataSnapshotFixture } from "./plugin-metadata.test-support.js";
import { resolveProviderModelPolicySurface } from "./provider-model-routes.js";
import * as publicSurfaceRuntime from "./public-surface-runtime.js";
import { createTestPluginRegistry } from "./registry-runtime.test-helpers.js";
import { getPluginRegistryVersion } from "./runtime-state.js";
import { withPluginRuntimeRegistryScope } from "./runtime/gateway-request-scope.js";
import { createPluginRecord } from "./status.test-helpers.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("provider policy probes", () => {
  beforeEach(() => {
    vi.resetModules();
    clearPluginMetadataLifecycleCaches();
  });

  it("resolves one direct policy miss per captured owner and observes replacement", async () => {
    const rootDir = tempDirs.make("openclaw-provider-policy-probes-");
    const source = path.join(rootDir, "index.js");
    const policyPath = path.join(rootDir, "provider-policy-api.js");
    const pluginId = "captured-policy-probes";
    fs.writeFileSync(source, "export default {};\n");
    const captures: Array<{
      instance: PluginInstance;
      cache: ReturnType<typeof createPluginCache>;
    }> = [];
    const captureOwner = () => {
      const cache = createPluginCache();
      const builder = createTestPluginRegistry();
      const record = createPluginRecord({ id: pluginId, rootDir, source, origin: "global" });
      builder.registry.plugins.push(record);
      const instance = new PluginInstance(record.id, { record, registry: builder.registry });
      captures.push({ instance, cache });
      const metadata = withPluginCache(cache, () => {
        bindPluginInstanceModuleLoader({ instance, origin: record.origin, source, rootDir });
        instance.run(() =>
          builder.createApi(record, { config: {} }).registerProvider({
            id: record.id,
            label: "Captured policy probes",
            auth: [],
          }),
        );
        return createPluginMetadataSnapshotFixture({
          plugins: [{ id: pluginId, rootDir, source, origin: "global", providers: [pluginId] }],
        });
      });
      expect(builder.registry.providers[0]?.provider.id).toBe(pluginId);
      expect(getPluginRegistryVersion(builder.registry)).toBeUndefined();
      return {
        instance,
        metadata,
        run<T>(read: () => T): T {
          return withPluginRuntimeRegistryScope(builder.registry, () =>
            withPluginCache(cache, read),
          );
        },
      };
    };
    const resolvePath = vi.spyOn(publicSurfaceRuntime, "resolvePluginRootPublicSurfacePath");
    const policyLookups = () =>
      resolvePath.mock.calls.filter(
        ([params]) =>
          params.pluginId === pluginId && params.artifactBasename === "provider-policy-api.js",
      );
    try {
      const first = captureOwner();
      resolvePath.mockClear();
      const readFirst = () =>
        first.run(() => resolveProviderModelPolicySurface(pluginId, first.metadata));
      expect(readFirst()).toBeNull();
      expect(policyLookups()).toHaveLength(1);

      fs.writeFileSync(
        policyPath,
        'export function normalizeModelCatalogId() { return "replacement-model"; }\n',
      );
      resolvePath.mockClear();
      expect(readFirst()).toBeNull();
      expect(policyLookups()).toHaveLength(1);

      await first.instance.dispose();
      const replacement = captureOwner();
      const metadataTrap = {
        get plugins(): never {
          throw new Error("Direct policy hits must not inspect manifest metadata");
        },
      };
      const surface = replacement.run(() =>
        resolveProviderModelPolicySurface(pluginId, metadataTrap),
      );
      const normalize = surface?.normalizeModelCatalogId;
      expect(normalize).toBeTypeOf("function");
      expect(normalize?.({ provider: pluginId, modelId: "original-model" })).toBe(
        "replacement-model",
      );
      expect(normalize && getPluginValueInstance(normalize)).toBe(replacement.instance);
      await replacement.instance.dispose();
      expect(() => normalize?.({ provider: pluginId, modelId: "late-model" })).toThrow(
        "reloaded or disabled",
      );
    } finally {
      resolvePath.mockRestore();
      for (const capture of captures) {
        await capture.instance.dispose();
        await retirePluginCache(capture.cache);
      }
    }
  });
});
