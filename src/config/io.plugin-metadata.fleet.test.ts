import { afterEach, expect, it, vi } from "vitest";
import { loadPreparedInboundPluginRegistry } from "../agents/prepared-model-runtime.inbound-registry.js";
import { createPluginCache, withPluginCache } from "../plugins/plugin-cache.js";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";
import { completePluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { isPluginRegistryRetired } from "../plugins/registry-lifecycle.js";
import {
  getActivePluginRegistry,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "../plugins/runtime.js";
import { setPluginRuntimeLoadContext } from "../plugins/runtime/load-context.js";
import { createPluginRecord } from "../plugins/status.test-helpers.js";
import { resolveConfigWidePluginMetadataSnapshot } from "./io.plugin-metadata.js";

const { loadRegistry, loadRuntimeRegistry, readRuntimeEntrypoint } = vi.hoisted(() => ({
  loadRegistry: vi.fn(),
  loadRuntimeRegistry: vi.fn(),
  readRuntimeEntrypoint: vi.fn(() => {
    throw new Error("Fleet metadata fixtures must not acquire subprocess declarations");
  }),
}));

// Installed metadata is supplied below; no native worker belongs to this fixture.
// Keep its declaration out of the runner's compiled subprocess generation.
vi.mock("../infra/runtime-process-entrypoints.js", () => ({
  SQLITE_READONLY_CHILD_ARG: "--openclaw-sqlite-readonly-child",
  runtimeProcessEntrypoints: new Proxy({}, { get: readRuntimeEntrypoint }),
}));

vi.mock("../agents/runtime-plugins.js", () => ({
  loadAgentRuntimePluginRegistryHandle: loadRuntimeRegistry,
}));

vi.mock("../plugins/plugin-registry-snapshot.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/plugin-registry-snapshot.js")>()),
  loadPluginRegistrySnapshotWithMetadata: loadRegistry,
  preparePluginRegistrySnapshotReader:
    (params: Record<string, unknown>) => (workspaceDir: string | undefined) =>
      loadRegistry({ ...params, workspaceDir }),
}));

afterEach(() => {
  // Synthetic records have no plugin instances or persistent session state to close.
  const registry = getActivePluginRegistry();
  resetPluginRuntimeStateForTest();
  expect(getActivePluginRegistry()).toBeNull();
  if (registry) {
    expect(isPluginRegistryRetired(registry)).toBe(true);
  }
  expect(readRuntimeEntrypoint).not.toHaveBeenCalled();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  clearPluginMetadataLifecycleCaches();
});

it("materializes shared plugin metadata once across the fleet and retains its immutable facts", () => {
  const configSchema = { type: "object", properties: { label: { type: "string" } } };
  const source = createPluginMetadataSnapshotFixture({
    plugins: [{ id: "shared", providers: ["shared"], configSchema }],
  });
  loadRegistry.mockImplementation(({ workspaceDir }: { workspaceDir: string }) => ({
    snapshot: { ...source.index, workspaceDir },
    source: "derived",
    diagnostics: [],
    manifestRegistry: source.manifestRegistry,
  }));
  const config = {
    agents: {
      ownership: "explicit" as const,
      entries: Object.fromEntries(
        ["first", "second", "third"].map((id) => [id, { workspace: `/fleet/${id}` }]),
      ),
    },
  };
  const freeze = vi.spyOn(Object, "freeze");
  withPluginCache(createPluginCache(), () => {
    const params = { config, env: {}, installRecords: {}, allowCurrent: false };
    const snapshot = resolveConfigWidePluginMetadataSnapshot(params);
    expect(snapshot.plugins.map((plugin) => plugin.id)).toEqual(["shared"]);
    expect(snapshot.owners.providers.get("shared")).toEqual(["shared"]);
    expect(snapshot.workspaceDir).toBeUndefined();
    expect(snapshot.registryIndex.workspaceDir).toBe("/fleet/first");
    expect(snapshot.manifestRegistry.plugins[0]?.configSchema).toBe(configSchema);
    expect(freeze.mock.calls.filter(([value]) => value === configSchema)).toHaveLength(1);
    expect(Object.isFrozen(configSchema.properties.label)).toBe(true);
    expect(Object.isFrozen(source.index)).toBe(false);
    expect(() => {
      configSchema.properties.label.type = "number";
    }).toThrow();
    expect(resolveConfigWidePluginMetadataSnapshot(params)).toBe(snapshot);
    expect(freeze.mock.calls.filter(([value]) => value === configSchema)).toHaveLength(1);
    expect(loadRegistry).toHaveBeenCalledTimes(3);
  });
});

it("reuses the Gateway registry for a nine-workspace fleet without changing discovery provenance", () => {
  vi.stubEnv("OPENCLAW_DISABLE_BUNDLED_PLUGINS", "1");
  const workspaceDir = "/fleet/gateway";
  const workspaces = Array.from({ length: 9 }, (_, index) => `/fleet/agents/${index}`);
  const config = {
    agents: {
      ownership: "explicit" as const,
      defaults: { workspace: workspaceDir },
      entries: Object.fromEntries(
        workspaces.map((workspace, index) => [`agent-${index}`, { workspace }]),
      ),
    },
  };
  loadRegistry.mockClear();
  loadRuntimeRegistry.mockReset();
  loadRegistry.mockImplementation(({ workspaceDir: workspace }: { workspaceDir: string }) => {
    const source = createPluginMetadataSnapshotFixture({
      plugins: [
        { id: "shared", origin: "global", format: "bundle" },
        {
          id: `local-${workspaces.indexOf(workspace)}`,
          origin: "workspace",
          workspaceDir: workspace,
          rootDir: `${workspace}/plugin`,
          source: `${workspace}/plugin/index.js`,
        },
      ],
    });
    return {
      snapshot: {
        ...source.index,
        workspaceDir: workspace,
        plugins: source.index.plugins.map((plugin) =>
          plugin.origin === "workspace" ? { ...plugin, workspaceDir: workspace } : plugin,
        ),
      },
      source: "derived",
      diagnostics: [],
      manifestRegistry: source.manifestRegistry,
    };
  });
  withPluginCache(createPluginCache(), () => {
    const planning = resolveConfigWidePluginMetadataSnapshot({
      config,
      env: process.env,
      installRecords: {},
      allowCurrent: false,
    });
    expect(planning.bundledManifestRegistry).toBeUndefined();
    const metadata = completePluginMetadataSnapshot({
      snapshot: planning,
      config,
      env: process.env,
      workspaceDir,
    })!;
    expect(metadata).not.toBe(planning);
    const shared = metadata.plugins.find((plugin) => plugin.id === "shared")!;
    const registry = createEmptyPluginRegistry();
    registry.plugins.push(
      createPluginRecord({
        id: shared.id,
        origin: shared.origin,
        format: shared.format,
        rootDir: shared.rootDir,
        source: shared.source,
        status: "loaded",
      }),
    );
    setPluginRuntimeLoadContext(registry, {
      rawConfig: config,
      config,
      activationSourceConfig: config,
      autoEnabledReasons: {},
      workspaceDir,
      env: process.env,
      metadataSnapshot: metadata,
      manifestRegistry: metadata.manifestRegistry,
      logger: { info() {}, warn() {}, error() {}, debug() {} },
    });
    setActivePluginRegistry(registry, undefined, "gateway-bindable", workspaceDir);
    for (const workspace of workspaces) {
      expect(
        loadPreparedInboundPluginRegistry(
          { config, workspaceDir: workspace, allowGatewaySubagentBinding: true },
          metadata,
        ),
      ).toBe(registry);
    }
    expect(loadRuntimeRegistry).not.toHaveBeenCalled();
    expect(metadata.workspaceDir).toBe(workspaceDir);
    expect(metadata.registryIndex.workspaceDir).toBe(workspaces[0]);
    expect(
      metadata.plugins
        .filter((plugin) => plugin.origin === "workspace")
        .map((plugin) => plugin.workspaceDir),
    ).toEqual(workspaces);
    expect(
      metadata.index.plugins
        .filter((plugin) => plugin.origin === "workspace")
        .map((plugin) => plugin.workspaceDir),
    ).toEqual(workspaces);
    expect(loadRegistry.mock.calls.map(([params]) => params.workspaceDir)).toEqual(workspaces);
    expect(
      completePluginMetadataSnapshot({
        snapshot: planning,
        config,
        env: process.env,
        workspaceDir,
      }),
    ).toBe(metadata);

    const fallback = createEmptyPluginRegistry();
    loadRuntimeRegistry.mockReturnValue(fallback);
    setActivePluginRegistry(registry, undefined, "gateway-bindable", "/foreign/workspace");
    expect(
      loadPreparedInboundPluginRegistry({ config, allowGatewaySubagentBinding: true }, metadata),
    ).toBe(fallback);
    expect(loadRuntimeRegistry).toHaveBeenCalledOnce();

    const nextConfig = {
      ...config,
      agents: { ...config.agents, defaults: { workspace: "/fleet/next-gateway" } },
    };
    const next = resolveConfigWidePluginMetadataSnapshot({
      config: nextConfig,
      env: process.env,
      installRecords: {},
      allowCurrent: false,
    });
    expect(next).not.toBe(planning);
    expect(next.workspaceDir).toBe("/fleet/next-gateway");
    expect(next.registryIndex.workspaceDir).toBe(workspaces[0]);
  });
});
