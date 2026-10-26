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
  withPluginCache as withCache,
} from "./plugin-cache.js";
import { getPluginInstance } from "./plugin-instance-scope.js";
import { resolveDirectBundledProviderPolicySurface as directPolicy } from "./provider-policy-surface.js";
import * as publicSurfaceLoader from "./public-surface-loader.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";
import type { PluginRecord } from "./registry-types.js";
import { resetPluginRuntimeStateForTest, stageActivePluginRegistry } from "./runtime.js";
import { withPluginRuntimeRegistryScope as withRegistry } from "./runtime/gateway-request-scope.js";
import { createPluginRecord } from "./status.test-helpers.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const records: PluginRecord[] = [];
const policyArtifactSpy = () =>
  vi.spyOn(publicSurfaceLoader, "loadBundledPluginPublicArtifactModuleFromCandidatesSync");
function policyFiles(root: string, format: "module" | "commonjs", version?: string) {
  fs.mkdirSync(root, { recursive: true });
  const write = (file: string, content: string) => fs.writeFileSync(path.join(root, file), content);
  write("package.json", JSON.stringify({ type: format }));
  if (version !== undefined) {
    write(
      `provider-policy-api.${format === "module" ? "ts" : "js"}`,
      `${format === "module" ? "export const normalizeModelCatalogId" : "exports.normalizeModelCatalogId"} = () => ${JSON.stringify(version)};\n`,
    );
  }
  return write;
}
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
  policyFiles(root, "module", version)("index.ts", "export default {};\n");
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
const selectBundled = (root: string) => {
  vi.stubEnv("OPENCLAW_BUNDLED_PLUGINS_DIR", root);
  vi.stubEnv("OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR", "1");
};

describe("provider policy generations", () => {
  it.each([false, true])("reuses completed private registry policies (missing=%s)", (missing) => {
    const bundled = tempDirs.make("openclaw-policy-private-");
    const root = path.join(bundled, "policy-fixture");
    const write = policyFiles(root, "commonjs", missing ? undefined : "private-model");
    write("index.js", 'module.exports = { id: "policy-fixture", register() {} };');
    write(
      "openclaw.plugin.json",
      JSON.stringify({
        id: "policy-fixture",
        configSchema: { type: "object", additionalProperties: false },
      }),
    );
    selectBundled(bundled);
    vi.stubEnv("OPENCLAW_DISABLE_BUNDLED_PLUGINS", undefined);
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
    const candidates = policyArtifactSpy();
    withRegistry(registry, () => {
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
    policyArtifactSpy().mockReturnValue(null);
    const caches = Array.from({ length: 24 }, () => {
      const registry = Object.assign(new RetiredRegistry(), createEmptyPluginRegistry());
      stageActivePluginRegistry(registry, null, "default");
      const cache = createPluginCache();
      withCache(cache, () => expect(directPolicy("missing-policy")).toBeNull());
      return cache;
    });
    stageActivePluginRegistry(createEmptyPluginRegistry(), null, "default");
    await nextTurn();
    expect(queryObjects(RetiredRegistry)).toBe(0);
    for (const cache of caches) {
      withCache(cache, () => expect(directPolicy("missing-policy")).toBeNull());
    }
  });

  it("reuses bundled policy libraries across registry selection and retirement", () => {
    const root = tempDirs.make("openclaw-policy-generation-");
    const firstCache = createPluginCache();
    const { registry: first, record: firstRecord } = withCache(firstCache, () =>
      preparePolicy(path.join(root, "first"), "first"),
    );
    stageActivePluginRegistry(first, "first", "default");
    const candidates = policyArtifactSpy();
    const read = (cache: typeof firstCache, registry = first) =>
      withCache(cache, () => withRegistry(registry, canonicalize));
    const check = (value: string, count: number) => {
      expect(value).toBe("first");
      expect(candidates).toHaveBeenCalledTimes(count);
    };
    expect(read(firstCache)).toBe("first");
    check(read(firstCache), 1);

    const nextCache = createPluginCache();
    const { registry: next } = withCache(nextCache, () =>
      preparePolicy(path.join(root, "replacement"), "replacement"),
    );
    stageActivePluginRegistry(next, "replacement", "default");
    expect([read(nextCache, next), read(nextCache, next)]).toEqual(["replacement", "replacement"]);
    check(read(firstCache), 2);

    // A registry selection can change within one metadata owner as well.
    expect(read(firstCache, next)).toBe("replacement");
    check(read(firstCache), 3);
    invalidatePluginCacheMetadata(firstCache);
    check(read(firstCache), 4);
    stageActivePluginRegistry(first, "republished", "default");
    check(read(firstCache), 5);

    getPluginInstance(firstRecord)!.quiesce();
    check(read(firstCache), 5);
  });

  it("does not retain an absent policy while an unpublished registry is assembled", () => {
    const root = tempDirs.make("openclaw-policy-registration-");
    selectBundled(root);
    const registry = createEmptyPluginRegistry();
    withCache(createPluginCache(), () =>
      withRegistry(registry, () => {
        expect(directPolicy("policy-fixture")).toBeNull();
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
      policyFiles(pluginRoot, "commonjs", marker);
    }
    selectBundled(path.join(root, "first"));
    expect(canonicalize()).toBe("first");
    vi.stubEnv("OPENCLAW_BUNDLED_PLUGINS_DIR", path.join(root, "second"));
    expect(canonicalize()).toBe("second");
    vi.stubEnv("OPENCLAW_DISABLE_BUNDLED_PLUGINS", "1");
    expect(directPolicy("policy-fixture")).toBeNull();
  });
});
