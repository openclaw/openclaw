import { afterAll, afterEach, beforeAll, beforeEach, expect, vi } from "vitest";

/** Reuses real provider registrations while each case retains its own tool-schema inputs. */
export function useProviderToolSchemaRuntimeForTest(pluginIds: readonly string[]): void {
  let install: () => void = () => {
    throw new Error("Provider tool-schema fixture was not prepared");
  };
  let close = async () => {};
  let restore = () => {};
  beforeAll(async () => {
    const [loader, metadata, caches, generations, handles, runtime, registryRuntime] =
      await Promise.all([
        import("../../plugins/loader.js"),
        import("../../plugins/plugin-metadata-snapshot.js"),
        import("../../plugins/plugin-cache.js"),
        import("../../plugins/runtime/generation-scope.js"),
        import("../../plugins/provider-hook-runtime.js"),
        import("../../plugins/provider-runtime.js"),
        import("../../plugins/runtime.js"),
      ]);
    const config = {
      plugins: {
        allow: [...pluginIds],
        entries: Object.fromEntries(pluginIds.map((id) => [id, { enabled: true }])),
      },
    };
    const cache = caches.createPluginCache();
    const closeCache = async () => {
      expect((await caches.retirePluginCache(cache)).failures).toEqual([]);
    };
    close = closeCache;
    const prepared = caches.withPluginCache(cache, () => ({
      metadataSnapshot: metadata.loadPluginMetadataSnapshot({ config }),
      pluginRegistry: loader.loadOpenClawPlugins({
        config,
        onlyPluginIds: [...pluginIds],
        activate: false,
        throwOnLoadError: true,
      }),
    }));
    const normalize = runtime.normalizeProviderToolSchemasWithPlugin;
    const inspect = runtime.inspectProviderToolSchemasWithPlugin;
    const prepare = (params: Parameters<typeof normalize>[0]) => {
      if (params.runtimeHandle || !pluginIds.includes(params.provider)) {
        return params;
      }
      return {
        ...params,
        runtimeHandle: generations.withPluginRuntimeGenerationScope(prepared, () =>
          handles.resolveProviderRuntimePluginHandle({
            provider: params.provider,
            modelId: params.context.modelId,
            config: params.config,
            workspaceDir: params.workspaceDir,
            env: params.env,
          }),
        ),
      };
    };
    install = () => {
      const normalizeSpy = vi
        .spyOn(runtime, "normalizeProviderToolSchemasWithPlugin")
        .mockImplementation((params) => normalize(prepare(params)));
      const inspectSpy = vi
        .spyOn(runtime, "inspectProviderToolSchemasWithPlugin")
        .mockImplementation((params) => inspect(prepare(params)));
      restore = () => {
        normalizeSpy.mockRestore();
        inspectSpy.mockRestore();
      };
    };
    close = async () => {
      try {
        expect(
          (await registryRuntime.disposePluginRegistryInstances(prepared.pluginRegistry)).failures,
        ).toEqual([]);
      } finally {
        await closeCache();
      }
    };
  });
  beforeEach(() => install());
  afterEach(() => restore());
  afterAll(async () => {
    restore();
    await close();
  });
}
