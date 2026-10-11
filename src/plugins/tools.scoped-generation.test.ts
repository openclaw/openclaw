// Regression coverage for #167365: a prepared runtime generation scoped to
// selected runtime owners (e.g. the tools.effective inventory lease) must still
// discover enabled tool-only plugins from the full manifest contract view.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resetLogger, setLoggerOverride } from "../logging/logger.js";
import { loggingState } from "../logging/state.js";
import { adoptProcessPluginCache, createPluginCache } from "./plugin-cache.js";
import { getPluginInstance } from "./plugin-instance-scope.js";
import { projectPluginMetadataSnapshot } from "./plugin-metadata-snapshot.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";
import { createNamedToolEntry, createToolRegistry } from "./tools.optional.test-helpers.js";

const loadOpenClawPluginsMock = vi.fn();

vi.mock("./loader.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./loader.js")>();
  const loaderCache = await import("./loader-cache.js");
  const loadPluginRegistryHandle = (params: unknown) => loadOpenClawPluginsMock(params);
  return {
    ...actual,
    loadOpenClawPlugins: loadPluginRegistryHandle,
    loadPluginRegistryHandle,
    resolvePluginRegistryLoadCacheKey: loaderCache.resolvePluginRegistryLoadCacheKey,
  };
});

let resolvePluginTools: typeof import("./tools.js").resolvePluginTools;
let setCurrentPluginMetadataSnapshot: typeof import("./current-plugin-metadata.test-support.js").setCurrentPluginMetadataSnapshot;
let makeEmptyPluginMetadataOwners: typeof import("./current-plugin-metadata.test-support.js").makeEmptyPluginMetadataOwners;
let clearPluginMetadataLifecycleCaches: typeof import("./plugin-metadata-lifecycle.js").clearPluginMetadataLifecycleCaches;
let resetPluginRuntimeStateForTest: typeof import("./runtime.js").resetPluginRuntimeStateForTest;

function createToolManifest(
  id: string,
  toolNames: readonly string[],
  overrides: Record<string, unknown> = {},
) {
  return {
    id,
    origin: "bundled" as const,
    enabledByDefault: true,
    channels: [],
    providers: [],
    cliBackends: [],
    contracts: { tools: [...toolNames] },
    ...overrides,
  };
}

type TestSnapshot = {
  manifestRegistry: { plugins: Array<Record<string, unknown>>; diagnostics: unknown[] };
};

function installFullManifestSnapshot(params: {
  config: OpenClawConfig;
  plugins: Array<Record<string, unknown>>;
}): TestSnapshot {
  const plugins = params.plugins.map((plugin): Record<string, unknown> => ({
    rootDir: "/tmp",
    source: `/tmp/${String(plugin.id)}.js`,
    ...plugin,
  }));
  const manifestRegistry = { plugins, diagnostics: [] };
  const snapshot = {
    policyHash: "test",
    workspaceDir: "/tmp",
    bundledManifestRegistry: manifestRegistry,
    index: {
      version: 1,
      hostContractVersion: "test",
      compatRegistryVersion: "test",
      migrationVersion: 1,
      policyHash: "test",
      generatedAtMs: 0,
      installRecords: {},
      plugins: plugins.map((plugin) => ({
        pluginId: String(plugin.id),
        origin: plugin.origin,
        enabled: true,
        enabledByDefault: plugin.enabledByDefault,
        startup: {
          sidecar: false,
          memory: plugin.id === "memory-core",
          agentHarnesses: [],
        },
        compat: [],
      })),
      diagnostics: [],
    },
    registryDiagnostics: [],
    manifestRegistry,
    plugins,
    diagnostics: [],
    byPluginId: new Map(plugins.map((plugin) => [String(plugin.id), plugin])),
    normalizePluginId: (id: string) => id,
    owners: makeEmptyPluginMetadataOwners(),
    metrics: {
      registrySnapshotMs: 0,
      manifestRegistryMs: 0,
      ownerMapsMs: 0,
      totalMs: 0,
      indexPluginCount: plugins.length,
      manifestPluginCount: plugins.length,
    },
  };
  setCurrentPluginMetadataSnapshot(snapshot as never, {
    config: params.config,
    env: process.env,
    workspaceDir: "/tmp",
  });
  return snapshot;
}

function createContext(): { config: OpenClawConfig; workspaceDir: string } {
  return {
    config: {
      plugins: {
        enabled: true,
        load: { paths: ["/tmp/plugin.js"] },
        slots: { memory: "memory-core" },
        entries: { workboard: { enabled: true } },
      },
    },
    workspaceDir: "/tmp",
  };
}

describe("resolvePluginTools with a runtime-owner-scoped prepared generation", () => {
  beforeAll(async () => {
    ({ resolvePluginTools } = await import("./tools.js"));
    ({ makeEmptyPluginMetadataOwners, setCurrentPluginMetadataSnapshot } =
      await import("./current-plugin-metadata.test-support.js"));
    ({ clearPluginMetadataLifecycleCaches } = await import("./plugin-metadata-lifecycle.js"));
    ({ resetPluginRuntimeStateForTest } = await import("./runtime.js"));
  });

  beforeEach(() => {
    adoptProcessPluginCache(createPluginCache());
    loadOpenClawPluginsMock.mockReset();
    resetPluginRuntimeStateForTest?.();
    clearPluginMetadataLifecycleCaches?.();
  });

  afterEach(() => {
    resetPluginRuntimeStateForTest?.();
    clearPluginMetadataLifecycleCaches?.();
    setLoggerOverride(null);
    resetLogger();
    loggingState.rawConsole = null;
  });

  it("discovers enabled tool-only plugins missing from the scoped generation", async () => {
    const context = createContext();
    const fullSnapshot = installFullManifestSnapshot({
      config: context.config,
      plugins: [
        createToolManifest("memory-core", ["memory_search"]),
        createToolManifest("workboard", ["workboard_list", "workboard_add"]),
      ],
    });
    // Production inventory leases project the generation down to runtime owners;
    // mirror that narrowing through the real projection owner.
    const scopedSnapshot = projectPluginMetadataSnapshot(fullSnapshot as never, ["memory-core"]);
    expect(scopedSnapshot.plugins.map((plugin) => plugin.id)).toEqual(["memory-core"]);

    const memoryRegistry = createToolRegistry([
      createNamedToolEntry("memory-core", "memory_search"),
    ]);
    const workboardRegistry = createToolRegistry([
      createNamedToolEntry("workboard", ["workboard_list", "workboard_add"]),
    ]);
    loadOpenClawPluginsMock.mockImplementation((params: { onlyPluginIds?: string[] }) =>
      params.onlyPluginIds?.includes("workboard") ? workboardRegistry : createEmptyPluginRegistry(),
    );

    const tools: Array<{ name: string }> = [];
    try {
      const resolved = resolvePluginTools({
        context: context as never,
        toolAllowlist: ["workboard_list", "workboard_add"],
        allowGatewaySubagentBinding: true,
        preparedRuntime: {
          loadContext: {
            rawConfig: context.config,
            config: context.config,
            activationSourceConfig: context.config,
            autoEnabledReasons: {},
            workspaceDir: context.workspaceDir,
            env: process.env,
            logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
            manifestRegistry: scopedSnapshot.manifestRegistry as never,
            metadataSnapshot: scopedSnapshot as never,
            installRecords: {},
          },
          metadataSnapshot: scopedSnapshot as never,
          registry: memoryRegistry as never,
        },
      });
      tools.push(...resolved.map((tool) => ({ name: tool.name })));
    } finally {
      await Promise.all(
        [memoryRegistry, workboardRegistry]
          .flatMap((registry) => registry.plugins)
          .map((record) => getPluginInstance(record)!.dispose()),
      );
    }

    expect(tools.map((tool) => tool.name)).toEqual(["workboard_list", "workboard_add"]);
    const loadCalls = loadOpenClawPluginsMock.mock.calls.map(
      ([params]) => (params as { onlyPluginIds?: string[] }).onlyPluginIds,
    );
    expect(loadCalls).toContainEqual(["workboard"]);
  });
});
