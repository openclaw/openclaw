import fs from "node:fs";
import path from "node:path";
import { normalizeConfiguredProviderCatalogModelId } from "@openclaw/model-catalog-core/provider-model-id-normalization";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import { normalizeStaticProviderModelId } from "../agents/model-ref-shared.js";
import { captureEnv, deleteTestEnvValue, setTestEnvValue } from "../test-utils/env.js";
import { withPluginMetadataSnapshotScope } from "./current-plugin-metadata-snapshot.js";
import {
  makePluginMetadataIndex,
  setCurrentPluginMetadataSnapshot,
} from "./current-plugin-metadata.test-support.js";
import { writePersistedInstalledPluginIndex } from "./installed-plugin-index-store-write.js";
import { listOpenClawPluginManifestMetadata } from "./manifest-metadata-scan.js";
import { clearPluginMetadataLifecycleCaches } from "./plugin-metadata-lifecycle.js";
// Import registers the ESM resolver for Vitest's no-CJS-TS-hook fallback.
import {
  projectPluginMetadataSnapshot,
  resolvePluginMetadataSnapshot,
} from "./plugin-metadata-snapshot.js";
import { resetPluginRuntimeStateForTest } from "./runtime.js";

const tempDirs = createTempDirTracker();
const testEnvSnapshot = captureEnv([
  "OPENCLAW_STATE_DIR",
  "OPENCLAW_HOME",
  "OPENCLAW_DISABLE_BUNDLED_PLUGINS",
  "OPENCLAW_BUNDLED_PLUGINS_DIR",
]);

async function installNormalizer(prefix: string) {
  const stateDir = tempDirs.make("openclaw-model-id-normalization-");
  const pluginDir = path.join(stateDir, "extensions", "normalizer");
  const index = makePluginMetadataIndex("normalizer");
  index.plugins = index.plugins.map((plugin) => ({
    ...plugin,
    rootDir: pluginDir,
    manifestPath: path.join(pluginDir, "openclaw.plugin.json"),
  }));
  await writePersistedInstalledPluginIndex(index, { stateDir });
  writeNormalizerManifest({ pluginDir, prefix });
  setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);
  return pluginDir;
}

function writeNormalizerManifest(params: { pluginDir: string; prefix: string }): void {
  fs.mkdirSync(params.pluginDir, { recursive: true });
  fs.writeFileSync(
    path.join(params.pluginDir, "index.ts"),
    "throw new Error('runtime entry should not load while reading manifests');\n",
    "utf-8",
  );
  fs.writeFileSync(
    path.join(params.pluginDir, "openclaw.plugin.json"),
    JSON.stringify({
      id: "normalizer",
      configSchema: { type: "object" },
      providers: ["demo"],
      modelIdNormalization: { providers: { demo: { prefixWhenBare: params.prefix } } },
    }),
    "utf-8",
  );
}

function normalizeDemoModel(modelId = "demo-model"): string {
  return normalizeStaticProviderModelId("demo", modelId);
}

describe("manifest model id normalization", () => {
  beforeEach(() => {
    resetPluginRuntimeStateForTest();
    clearPluginMetadataLifecycleCaches();
    deleteTestEnvValue("OPENCLAW_HOME");
    setTestEnvValue("OPENCLAW_DISABLE_BUNDLED_PLUGINS", "1");
    deleteTestEnvValue("OPENCLAW_BUNDLED_PLUGINS_DIR");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetPluginRuntimeStateForTest();
    clearPluginMetadataLifecycleCaches();
    testEnvSnapshot.restore();
    tempDirs.cleanup();
  });

  it("does not reuse broader normalization policies in a narrowed metadata view", async () => {
    await installNormalizer("scoped");
    const snapshot = resolvePluginMetadataSnapshot({ config: {}, env: process.env });
    const narrowed = projectPluginMetadataSnapshot(snapshot, []);
    setCurrentPluginMetadataSnapshot(snapshot, { config: {}, env: process.env });
    const normalize = (view: typeof snapshot) =>
      withPluginMetadataSnapshotScope(view, () => normalizeDemoModel(), {
        trustConfigIdentity: true,
      });

    expect(normalize(snapshot)).toBe("scoped/demo-model");
    expect(normalize(narrowed)).toBe("demo-model");
    expect(normalizeConfiguredProviderCatalogModelId("demo", "demo-model")).toBe(
      "scoped/demo-model",
    );
    expect(
      normalizeConfiguredProviderCatalogModelId(
        "demo",
        "demo-model",
        narrowed.owners.modelIdNormalizationPolicies,
      ),
    ).toBe("demo-model");
    expect(normalize(snapshot)).toBe("scoped/demo-model");
  });

  it("keeps process metadata stable until the lifecycle owner reloads it", async () => {
    const pluginDirA = await installNormalizer("alpha");
    expect(normalizeDemoModel()).toBe("alpha/demo-model");

    writeNormalizerManifest({ pluginDir: pluginDirA, prefix: "bravo-local" });
    expect(normalizeDemoModel()).toBe("alpha/demo-model");

    clearPluginMetadataLifecycleCaches();
    expect(normalizeDemoModel()).toBe("bravo-local/demo-model");

    await installNormalizer("charlie");
    clearPluginMetadataLifecycleCaches();
    expect(normalizeDemoModel()).toBe("charlie/demo-model");
  });

  it("reuses manifest metadata for the same environment identity", async () => {
    const pluginDir = await installNormalizer("alpha");

    // Ignore source-checkout extensions returned alongside the fixture.
    const listNormalizerRecords = () =>
      listOpenClawPluginManifestMetadata(process.env).filter(
        (record) => record.pluginDir === pluginDir,
      );
    const firstRecords = listNormalizerRecords();
    const readFile = vi.spyOn(fs, "readFileSync");
    const readBytes = vi.spyOn(fs, "readSync");
    const secondRecords = listNormalizerRecords();
    expect(firstRecords).toHaveLength(1);
    expect(secondRecords).toEqual(firstRecords);
    expect(secondRecords[0]?.manifest).toBe(firstRecords[0]?.manifest);
    expect([readFile.mock.calls, readBytes.mock.calls]).toEqual([[], []]);
  });
});
