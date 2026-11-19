// Real discovery and owner eligibility must consume the selected snapshot's policy aliases.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { withPluginMetadataSnapshotScope } from "./current-plugin-metadata-snapshot.js";
import type { PluginLoadOptions } from "./loader-types.js";
import { clearPluginMetadataLifecycleCaches } from "./plugin-metadata-lifecycle.js";
import {
  projectPluginMetadataSnapshot,
  restorePluginMetadataSnapshot,
} from "./plugin-metadata-snapshot.js";
import type { PluginMetadataRegistryView } from "./plugin-metadata-snapshot.types.js";
import { createPluginMetadataSnapshotFixture } from "./plugin-metadata.test-support.js";
import * as registryNormalizer from "./plugin-registry-id-normalizer.js";
import { planPluginDiscoveryRuntime } from "./provider-discovery.runtime.js";
import { createProviderRegistryResolver } from "./providers.runtime-core.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";

function prepareSnapshot() {
  const fixture = createPluginMetadataSnapshotFixture({
    plugins: [
      { id: "Alpha", providerId: "alpha-provider", origin: "bundled" as const },
      { id: "Beta", providerId: "beta-provider", origin: "global" as const },
      { id: "Workspace", providerId: "workspace-provider", origin: "workspace" as const },
    ].map(({ id, providerId, origin }) => ({
      id,
      providers: id === "Workspace" ? [providerId] : [providerId, "shared"],
      origin,
      enabledByDefault: true,
      modelCatalog: {
        providers: {
          [providerId]: {
            baseUrl: "https://catalog.example.test/v1",
            api: "openai-responses" as const,
            models: [
              { id: "fixture-model", name: "Fixture Model", contextWindow: 8192, maxTokens: 1024 },
            ],
          },
        },
      },
    })),
  });
  const { normalizePluginId: _resolver, ...transport } = fixture;
  return restorePluginMetadataSnapshot(structuredClone(transport));
}

function discover(
  snapshot: PluginMetadataRegistryView,
  config: OpenClawConfig,
  options: { onlyPluginIds?: string[]; includeUntrustedWorkspacePlugins?: boolean } = {},
) {
  return planPluginDiscoveryRuntime({
    pluginMetadataSnapshot: snapshot,
    config,
    env: {},
    discoveryEntriesOnly: true,
    ...options,
  }).providers;
}

afterEach(() => {
  vi.restoreAllMocks();
  clearPluginMetadataLifecycleCaches();
});

describe("prepared discovery policy", () => {
  it("reuses restored aliases while recomputing policy for each config", async () => {
    const snapshot = prepareSnapshot();
    const constructor = vi.spyOn(registryNormalizer, "createPluginRegistryIdNormalizer");
    const cases: Array<[OpenClawConfig, string[]]> = [
      [{}, ["Alpha", "Beta"]],
      [{ plugins: { allow: [" SHARED "] } }, ["Alpha"]],
      [{ plugins: { deny: ["shared"] } }, ["Beta"]],
      [{ plugins: { entries: { "alpha-provider": { enabled: false } } } }, ["Beta"]],
      [
        { plugins: { entries: { Alpha: { enabled: false }, shared: { enabled: true } } } },
        ["Alpha", "Beta"],
      ],
      [
        { plugins: { entries: { shared: { enabled: true }, Alpha: { enabled: false } } } },
        ["Beta"],
      ],
      [{ plugins: { allow: ["workspace-provider"] } }, ["Workspace"]],
      [{ plugins: { enabled: false } }, []],
    ];
    for (const [config, expected] of cases) {
      expect(discover(snapshot, config).map((provider) => provider.pluginId)).toEqual(expected);
    }
    const [provider] = discover(snapshot, { plugins: { allow: ["shared"] } });
    if (!provider?.staticCatalog) {
      throw new Error("Expected the selected provider to expose its static catalog");
    }
    expect(
      await provider.staticCatalog.run({
        config: {},
        env: {},
        resolveProviderApiKey: () => ({ apiKey: undefined }),
        resolveProviderAuth: () => ({ apiKey: undefined, mode: "none", source: "none" }),
      }),
    ).toMatchObject({
      providers: { "alpha-provider": { models: [{ id: "fixture-model" }] } },
    });
    expect(discover(snapshot, {}, { onlyPluginIds: [] })).toEqual([]);
    expect(discover(snapshot, {}, { onlyPluginIds: ["Beta"] }).map((p) => p.pluginId)).toEqual([
      "Beta",
    ]);
    expect(
      discover(snapshot, {}, { includeUntrustedWorkspacePlugins: true }).map((p) => p.pluginId),
    ).toEqual(["Alpha", "Beta", "Workspace"]);
    expect(constructor).not.toHaveBeenCalled();
  });

  it("uses projected colliding aliases and preserves the reduced-view fallback", () => {
    const full = prepareSnapshot();
    const projected = projectPluginMetadataSnapshot(full, ["Beta"]);
    const constructor = vi.spyOn(registryNormalizer, "createPluginRegistryIdNormalizer");
    const config = { plugins: { allow: ["shared"] } };
    withPluginMetadataSnapshotScope(projected, () => {
      expect(discover(full, config).map((p) => p.pluginId)).toEqual(["Alpha"]);
    });
    expect(discover(projected, config).map((p) => p.pluginId)).toEqual(["Beta"]);
    expect(discover(projected, { plugins: { deny: ["shared"] } })).toEqual([]);
    expect(constructor).not.toHaveBeenCalled();

    const reduced = { index: projected.index, manifestRegistry: projected.manifestRegistry };
    expect(discover(reduced, config).map((p) => p.pluginId)).toEqual(["Beta"]);
    expect(constructor).toHaveBeenCalledTimes(1);
  });

  it("reuses the projected resolver across setup and runtime activation configs", () => {
    const snapshot = projectPluginMetadataSnapshot(prepareSnapshot(), ["Beta"]);
    // Registration is fixed external I/O; selection and activation policy remain real.
    const load = vi.fn((options: PluginLoadOptions = {}) => {
      const registry = createEmptyPluginRegistry();
      if (options.onlyPluginIds?.includes("Beta")) {
        registry.providers.push({
          pluginId: "Beta",
          source: "fixture",
          provider: { id: "beta-provider", label: "Beta", auth: [] },
        });
      }
      return registry;
    });
    const resolver = createProviderRegistryResolver({
      loadOpenClawPlugins: load,
      resolveRuntimePluginRegistry: load,
      isPluginRegistryLoadInFlight: () => false,
    });
    const constructor = vi.spyOn(registryNormalizer, "createPluginRegistryIdNormalizer");
    for (const mode of ["setup", "runtime"] as const) {
      const params = {
        mode,
        pluginMetadataSnapshot: snapshot,
        onlyPluginIds: ["Beta"],
        env: {},
        workspaceDir: "/workspace/prepared-policy",
        registryScope: "exact" as const,
        applyAutoEnable: false,
      };
      expect(
        resolver
          .resolvePluginProvidersCore({
            ...params,
            config: { plugins: { allow: ["shared"] } },
          })
          .map((provider) => provider.pluginId),
      ).toEqual(["Beta"]);
      expect(
        resolver.resolvePluginProvidersCore({
          ...params,
          config: { plugins: { allow: ["shared"], entries: { shared: { enabled: false } } } },
        }),
      ).toEqual([]);
    }
    expect(load).toHaveBeenCalledTimes(2);
    expect(constructor).not.toHaveBeenCalled();
  });
});
