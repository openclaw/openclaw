import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { loadAgentRuntimePluginRegistryHandle } from "../agents/runtime-plugins.js";
import { captureRuntimeConfigWithSource } from "../config/runtime-config-capture-state.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  cleanupPluginLoaderFixturesForTest,
  clearPluginLoaderCache,
  loadOpenClawPlugins,
  makePluginLoaderTempDir,
  writePlugin,
} from "./loader.test-fixtures.js";
import { createPluginMetadataSnapshotFixture } from "./plugin-metadata.test-support.js";
import { resolvePluginProviderRegistryCore } from "./providers.runtime.js";
import { withPluginRuntimeRegistryScope } from "./runtime/gateway-request-scope.js";

function fixture(alias = "provider-alias") {
  const root = makePluginLoaderTempDir();
  const marker = path.join(root, "registrations.log");
  writeFileSync(marker, "");
  const plugin = writePlugin({
    id: "owner",
    dir: root,
    filename: "index.cjs",
    body:
      'module.exports={id:"owner",register(api){require("node:fs").appendFileSync(' +
      JSON.stringify(marker) +
      ', "registered\\n");const marker=api.pluginConfig.marker;api.registerProvider({id:"provider-alias",label:marker,auth:[],normalizeModelId:()=>marker});}};',
  });
  const manifest = {
    id: "owner",
    origin: "global" as const,
    rootDir: root,
    source: plugin.file,
    providers: ["provider-alias"],
    configSchema: {
      type: "object",
      properties: { marker: { type: "string" } },
      required: ["marker"],
      additionalProperties: false,
    },
  };
  writeFileSync(path.join(root, "openclaw.plugin.json"), JSON.stringify(manifest));
  const snapshot = createPluginMetadataSnapshotFixture({ plugins: [manifest] });
  const runtime: OpenClawConfig = {
    plugins: {
      allow: ["owner"],
      entries: { [alias]: { enabled: true, config: { marker: "configured" } } },
    },
  };
  const config = captureRuntimeConfigWithSource(runtime, {
    plugins: {
      ...runtime.plugins,
      entries: { [alias]: { enabled: true, config: { marker: "authored" } } },
    },
  });
  const query = {
    config,
    env: {},
    providerRefs: ["provider-alias"],
    pluginMetadataSnapshot: snapshot,
  };
  return { config, snapshot, query, registrations: () => readFileSync(marker, "utf8") };
}

afterEach(clearPluginLoaderCache);
afterAll(cleanupPluginLoaderFixturesForTest);

describe("provider registration identity from prepared aliases", () => {
  it("reuses prepared callbacks and rejects changed payloads in request and loaded-only lookup", () => {
    const proof = fixture();
    const registry = loadAgentRuntimePluginRegistryHandle({
      config: proof.config,
      env: {},
      metadataSnapshot: proof.snapshot,
      basePluginIds: ["owner"],
      purpose: "model-catalog",
    });
    const original = registry.providers[0]?.provider;
    expect(original?.label).toBe("configured");
    withPluginRuntimeRegistryScope(registry, () => {
      expect(resolvePluginProviderRegistryCore(proof.query)?.registry).toBe(registry);
      expect(
        resolvePluginProviderRegistryCore({ ...proof.query, registryScope: "loaded" })?.registry,
      ).toBe(registry);
      const { pluginMetadataSnapshot: _snapshot, ...withoutMetadata } = proof.query;
      expect(
        resolvePluginProviderRegistryCore({ ...withoutMetadata, registryScope: "loaded" })
          ?.registry,
      ).toBe(registry);
      const changed = {
        ...proof.config,
        plugins: {
          ...proof.config.plugins,
          entries: { "provider-alias": { enabled: true, config: { marker: "changed" } } },
        },
      };
      expect(
        resolvePluginProviderRegistryCore({
          ...proof.query,
          config: changed,
          registryScope: "loaded",
        }),
      ).toBeUndefined();
      expect(
        resolvePluginProviderRegistryCore({
          ...withoutMetadata,
          config: changed,
          registryScope: "loaded",
        }),
      ).toBeUndefined();
      const changedSource = captureRuntimeConfigWithSource(proof.config, changed);
      expect(
        resolvePluginProviderRegistryCore({
          ...proof.query,
          config: changedSource,
          registryScope: "loaded",
        }),
      ).toBeUndefined();
      expect(
        resolvePluginProviderRegistryCore({
          ...withoutMetadata,
          config: changedSource,
          registryScope: "loaded",
        }),
      ).toBeUndefined();
      const selected = resolvePluginProviderRegistryCore(proof.query)?.registry.providers[0]
        ?.provider;
      expect(selected?.normalizeModelId).toBe(original?.normalizeModelId);
      expect(selected?.normalizeModelId?.({ provider: "provider-alias", modelId: "raw" })).toBe(
        "configured",
      );
    });
    expect(proof.registrations()).toBe("registered\n");
  });

  it("carries aliased settings into an ordinary fallback registration", () => {
    const proof = fixture();
    const selected = resolvePluginProviderRegistryCore(proof.query);
    expect(selected?.registry.providers[0]?.provider.label).toBe("configured");
    expect(proof.registrations()).toBe("registered\n");
  });

  it("retains ordinary normalization when no resolver is captured", () => {
    const proof = fixture("owner");
    const registry = loadOpenClawPlugins({
      config: proof.config,
      env: {},
      installRecords: {},
      manifestRegistry: proof.snapshot.manifestRegistry,
      onlyPluginIds: ["owner"],
      activate: false,
    });
    withPluginRuntimeRegistryScope(registry, () => {
      const { pluginMetadataSnapshot: _snapshot, ...query } = proof.query;
      expect(
        resolvePluginProviderRegistryCore({ ...query, registryScope: "loaded" })?.registry,
      ).toBe(registry);
    });
    expect(proof.registrations()).toBe("registered\n");
  });
});
