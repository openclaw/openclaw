import fs from "node:fs";
import path from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { queryObjects } from "node:v8";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { canonicalizeProviderModelId } from "../agents/provider-model-route.js";
import { createPluginModuleLoader } from "./loader-module-runtime.js";
import { loadPluginRegistryHandle } from "./loader.js";
import {
  createPluginCache,
  invalidatePluginCacheMetadata,
  resetPluginCache,
  withPluginCache,
} from "./plugin-cache.js";
import { getPluginInstance } from "./plugin-instance-scope.js";
import { resolveDirectBundledProviderPolicySurface } from "./provider-policy-surface.js";
import * as publicSurfaceLoader from "./public-surface-loader.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";
import type { PluginRecord } from "./registry-types.js";
import { resetPluginRuntimeStateForTest, stageActivePluginRegistry } from "./runtime.js";
import { withPluginRuntimeRegistryScope } from "./runtime/gateway-request-scope.js";
import { createPluginRecord } from "./status.test-helpers.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const records: PluginRecord[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const record of records.splice(0)) {
    await getPluginInstance(record)?.dispose();
  }
  resetPluginRuntimeStateForTest();
  resetPluginCache();
});

function preparePolicy(root: string, version: string) {
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, "package.json"), '{"type":"module"}');
  fs.writeFileSync(path.join(root, "index.ts"), "export default {};\n");
  fs.writeFileSync(
    path.join(root, "provider-policy-api.ts"),
    `export const normalizeModelCatalogId = () => ${JSON.stringify(version)};\n`,
  );
  const registry = createEmptyPluginRegistry();
  const record = createPluginRecord({
    id: "policy-fixture",
    source: path.join(root, "index.ts"),
    rootDir: root,
    origin: "bundled",
  });
  registry.plugins.push(record);
  records.push(record);
  const load = createPluginModuleLoader({ installNativeSdkResolver: false });
  load(record.source, { record, rootDir: root, registry });
  return { registry, record };
}

const canonicalize = () => canonicalizeProviderModelId("policy-fixture", "authored-id");

describe("provider policy generations", () => {
  it.each([false, true])("reuses completed private registry policies (missing=%s)", (missing) => {
    const bundled = tempDirs.make("openclaw-policy-private-");
    const root = path.join(bundled, "policy-fixture");
    fs.mkdirSync(root);
    fs.writeFileSync(path.join(root, "package.json"), '{"type":"commonjs"}');
    fs.writeFileSync(
      path.join(root, "index.js"),
      'module.exports = { id: "policy-fixture", register() {} };',
    );
    fs.writeFileSync(
      path.join(root, "openclaw.plugin.json"),
      JSON.stringify({
        id: "policy-fixture",
        configSchema: { type: "object", additionalProperties: false },
      }),
    );
    if (!missing) {
      fs.writeFileSync(
        path.join(root, "provider-policy-api.js"),
        'exports.normalizeModelCatalogId = () => "private-model";',
      );
    }
    vi.stubEnv("OPENCLAW_BUNDLED_PLUGINS_DIR", bundled);
    vi.stubEnv("OPENCLAW_DISABLE_BUNDLED_PLUGINS", undefined);
    vi.stubEnv("OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR", "1");
    const registry = loadPluginRegistryHandle({
      config: {
        plugins: {
          allow: ["policy-fixture"],
          entries: { "policy-fixture": { enabled: true } },
          slots: { memory: "none" },
        },
      },
      onlyPluginIds: ["policy-fixture"],
      cache: false,
    });
    records.push(...registry.plugins);
    expect(registry.plugins).toEqual([
      expect.objectContaining({ id: "policy-fixture", status: "loaded" }),
    ]);
    const candidates = vi.spyOn(
      publicSurfaceLoader,
      "loadBundledPluginPublicArtifactModuleFromCandidatesSync",
    );
    withPluginRuntimeRegistryScope(registry, () => {
      for (let index = 0; index < 3; index++) {
        expect(canonicalize()).toBe(missing ? "authored-id" : "private-model");
      }
    });
    expect(candidates).toHaveBeenCalledTimes(1);
  });

  it("does not retain published registries through surviving policy caches", async () => {
    class RetiredRegistry {
      readonly fixtureLabel = "RetiredRegistry";
    }
    vi.spyOn(
      publicSurfaceLoader,
      "loadBundledPluginPublicArtifactModuleFromCandidatesSync",
    ).mockReturnValue(null);
    const caches = Array.from({ length: 24 }, () => {
      const registry = Object.assign(new RetiredRegistry(), createEmptyPluginRegistry());
      stageActivePluginRegistry(registry, null, "default");
      const cache = createPluginCache();
      withPluginCache(cache, () =>
        expect(resolveDirectBundledProviderPolicySurface("missing-policy")).toBeNull(),
      );
      return cache;
    });
    stageActivePluginRegistry(createEmptyPluginRegistry(), null, "default");
    await nextTurn();
    expect(queryObjects(RetiredRegistry)).toBe(0);
    for (const cache of caches) {
      withPluginCache(cache, () =>
        expect(resolveDirectBundledProviderPolicySurface("missing-policy")).toBeNull(),
      );
    }
  });

  it("reuses bundled policy libraries across registry selection and retirement", () => {
    const root = tempDirs.make("openclaw-policy-generation-");
    const firstCache = createPluginCache();
    const { registry: first, record: firstRecord } = withPluginCache(firstCache, () =>
      preparePolicy(path.join(root, "first"), "first"),
    );
    stageActivePluginRegistry(first, "first", "default");
    const candidates = vi.spyOn(
      publicSurfaceLoader,
      "loadBundledPluginPublicArtifactModuleFromCandidatesSync",
    );
    const readFirst = () =>
      withPluginCache(firstCache, () => withPluginRuntimeRegistryScope(first, canonicalize));
    expect(readFirst()).toBe("first");
    expect(readFirst()).toBe("first");
    expect(candidates).toHaveBeenCalledTimes(1);

    const nextCache = createPluginCache();
    const { registry: next } = withPluginCache(nextCache, () =>
      preparePolicy(path.join(root, "replacement"), "replacement"),
    );
    stageActivePluginRegistry(next, "replacement", "default");
    const readNext = () =>
      withPluginCache(nextCache, () => withPluginRuntimeRegistryScope(next, canonicalize));
    expect(readNext()).toBe("replacement");
    expect(readNext()).toBe("replacement");
    expect(readFirst()).toBe("first");
    expect(candidates).toHaveBeenCalledTimes(2);

    // A registry selection can change within one metadata owner as well.
    expect(
      withPluginCache(firstCache, () => withPluginRuntimeRegistryScope(next, canonicalize)),
    ).toBe("replacement");
    expect(readFirst()).toBe("first");
    expect(candidates).toHaveBeenCalledTimes(3);
    invalidatePluginCacheMetadata(firstCache);
    expect(readFirst()).toBe("first");
    expect(candidates).toHaveBeenCalledTimes(4);
    stageActivePluginRegistry(first, "republished", "default");
    expect(readFirst()).toBe("first");
    expect(candidates).toHaveBeenCalledTimes(5);

    getPluginInstance(firstRecord)!.quiesce();
    expect(readFirst()).toBe("first");
    expect(candidates).toHaveBeenCalledTimes(5);
  });

  it("does not retain an absent policy while an unpublished registry is assembled", () => {
    const root = tempDirs.make("openclaw-policy-registration-");
    vi.stubEnv("OPENCLAW_BUNDLED_PLUGINS_DIR", root);
    vi.stubEnv("OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR", "1");
    const registry = createEmptyPluginRegistry();
    withPluginCache(createPluginCache(), () =>
      withPluginRuntimeRegistryScope(registry, () => {
        expect(resolveDirectBundledProviderPolicySurface("policy-fixture")).toBeNull();
        const { registry: prepared } = preparePolicy(
          path.join(root, "selected", "policy-fixture"),
          "new-owner",
        );
        registry.plugins.push(...prepared.plugins);
        expect(canonicalize()).toBe("new-owner");
      }),
    );
  });

  it("keeps bundled environment selection in the cache identity", () => {
    const root = tempDirs.make("openclaw-policy-environment-");
    for (const marker of ["first", "second"]) {
      const pluginRoot = path.join(root, marker, "policy-fixture");
      fs.mkdirSync(pluginRoot, { recursive: true });
      fs.writeFileSync(path.join(pluginRoot, "package.json"), '{"type":"commonjs"}');
      fs.writeFileSync(
        path.join(pluginRoot, "provider-policy-api.js"),
        `exports.normalizeModelCatalogId = () => "${marker}";\n`,
      );
    }
    vi.stubEnv("OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR", "1");
    vi.stubEnv("OPENCLAW_BUNDLED_PLUGINS_DIR", path.join(root, "first"));
    expect(canonicalize()).toBe("first");
    vi.stubEnv("OPENCLAW_BUNDLED_PLUGINS_DIR", path.join(root, "second"));
    expect(canonicalize()).toBe("second");
    vi.stubEnv("OPENCLAW_DISABLE_BUNDLED_PLUGINS", "1");
    expect(resolveDirectBundledProviderPolicySurface("policy-fixture")).toBeNull();
  });
});
