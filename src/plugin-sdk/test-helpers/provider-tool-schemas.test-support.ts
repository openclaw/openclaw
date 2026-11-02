import { afterAll, afterEach, beforeAll, beforeEach, expect, vi } from "vitest";

export function useProviderToolSchemaRuntimeForTest(pluginIds: readonly string[]): void {
  const expectClean = (result: { failures: readonly unknown[] }) =>
    expect(result.failures).toEqual([]);
  let install: () => void = () => {
    throw new Error("Provider tool-schema fixture was not prepared");
  };
  let close = async () => {};
  let restore = () => {};
  beforeAll(async () => {
    const [loader, metadata, caches, scopes, handles, runtime, registry, snapshots] =
      await Promise.all([
        import("../../plugins/loader.js"),
        import("../../plugins/plugin-metadata-snapshot.js"),
        import("../../plugins/plugin-cache.js"),
        import("../../plugins/runtime/generation-scope.js"),
        import("../../plugins/provider-hook-runtime.js"),
        import("../../plugins/provider-runtime.js"),
        import("../../plugins/runtime.js"),
        import("../../config/runtime-snapshot.js"),
      ]);
    const config = {
      plugins: {
        allow: [...pluginIds],
        entries: Object.fromEntries(pluginIds.map((id) => [id, { enabled: true }])),
      },
    };
    const cache = caches.createPluginCache();
    const closeCache = async () => expectClean(await caches.retirePluginCache(cache));
    close = closeCache;
    const prepared = caches.withPluginCache(cache, () => {
      const previousConfig = snapshots.getRuntimeConfigSnapshot();
      const previousSource = snapshots.getRuntimeConfigSourceSnapshot();
      snapshots.setRuntimeConfigSnapshot(config);
      try {
        return {
          metadataSnapshot: metadata.loadPluginMetadataSnapshot({ config }),
          pluginRegistry: loader.loadOpenClawPlugins({
            config,
            onlyPluginIds: [...pluginIds],
            activate: false,
            throwOnLoadError: true,
          }),
        };
      } finally {
        if (previousConfig) {
          snapshots.setRuntimeConfigSnapshot(previousConfig, previousSource ?? undefined);
        } else {
          snapshots.clearRuntimeConfigSnapshot();
        }
      }
    });
    const normalize = runtime.normalizeProviderToolSchemasWithPlugin;
    const inspect = runtime.inspectProviderToolSchemasWithPlugin;
    const prepare = (params: Parameters<typeof normalize>[0]) => {
      if (params.runtimeHandle || !pluginIds.includes(params.provider)) {
        return params;
      }
      return {
        ...params,
        runtimeHandle: scopes.withPluginRuntimeGenerationScope(prepared, () =>
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
        expectClean(await registry.disposePluginRegistryInstances(prepared.pluginRegistry));
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
