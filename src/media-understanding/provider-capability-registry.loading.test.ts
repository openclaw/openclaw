import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.js";
import { waitForPluginCacheRetirement } from "../plugins/plugin-cache.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { resetPluginRuntimeStateForTest } from "../plugins/runtime.js";
import { withPluginRuntimeGenerationScope } from "../plugins/runtime/generation-scope.js";
import { createColdPluginFixture } from "../plugins/test-helpers/cold-plugin-fixtures.js";
import { mediaModels } from "./media-config.test-support.js";
import { buildMediaUnderstandingCapabilityRegistry } from "./provider-capability-registry.js";

let root: string;

async function resetFixtureState() {
  resetPluginRuntimeStateForTest();
  await waitForPluginCacheRetirement();
}

function createMediaOwner(pluginId: string, providerId: string) {
  const rootDir = path.join(root, pluginId);
  fs.mkdirSync(rootDir);
  const fixture = createColdPluginFixture({
    rootDir,
    pluginId,
    providerId,
    manifest: {
      channels: [],
      providers: [],
      activation: { onStartup: false },
      contracts: { mediaUnderstandingProviders: [providerId] },
    },
  });
  fs.writeFileSync(
    fixture.runtimeSource,
    `require("node:fs").appendFileSync(${JSON.stringify(fixture.runtimeMarker)}, ${JSON.stringify("import\n")});
module.exports = {
  id: ${JSON.stringify(pluginId)},
  register(api) {
    api.registerMediaUnderstandingProvider({
      id: ${JSON.stringify(providerId)}, capabilities: ["audio"]
    });
  }
};
`,
  );
  return fixture;
}

beforeEach(async () => {
  await resetFixtureState();
  root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-media-inference-"));
});

afterEach(async () => {
  await resetFixtureState();
  fs.rmSync(root, { recursive: true, force: true });
});

it.each([
  [true, "qa-audio", "qa-audio", false, false],
  [false, "qa-audio", "qa-audio", false, false],
  [true, "google", " GEMINI ", false, false],
  [true, "qa-audio", "qa-audio", true, false],
  [true, "qa-audio", "qa-audio", false, true],
] as const)(
  "infers capabilities without unrelated imports (active=%s provider=%s alias=%s imageFallback=%s taggedPeers=%s)",
  (active, providerId, configuredId, imageFallback, taggedPeers) => {
    const selected = createMediaOwner("qa-selected-owner", providerId);
    const unrelated = createMediaOwner("qa-unrelated-owner", "qa-unrelated");
    const config: OpenClawConfig = {
      plugins: {
        allow: [selected.pluginId, unrelated.pluginId],
        load: { paths: [selected.rootDir, unrelated.rootDir] },
        entries: Object.fromEntries(
          [selected, unrelated].map(({ pluginId }) => [pluginId, { enabled: true }]),
        ),
      },
      tools: {
        media: {
          models: [
            ...(taggedPeers
              ? [
                  { provider: configuredId, capabilities: ["image" as const] },
                  { provider: unrelated.providerId, capabilities: ["audio" as const] },
                ]
              : []),
            { provider: configuredId },
          ],
        },
      },
    };
    if (imageFallback) {
      config.models = mediaModels(providerId, "fixture-image", ["text", "image"]);
    }
    const registry = createEmptyPluginRegistry();
    if (active) {
      registry.mediaUnderstandingProviders.push({
        pluginId: selected.pluginId,
        pluginName: "Selected fixture",
        source: selected.runtimeSource,
        provider: { id: providerId, capabilities: ["audio"] },
      });
    }

    const metadataSnapshot = createPluginMetadataSnapshotFixture({
      plugins: [selected, unrelated].map((fixture) => ({
        id: fixture.pluginId,
        origin: "global",
        rootDir: fixture.rootDir,
        source: fixture.runtimeSource,
        configSchema: { type: "object" },
        contracts: { mediaUnderstandingProviders: [fixture.providerId] },
      })),
    });
    const capabilities = withPluginRuntimeGenerationScope(
      { metadataSnapshot, pluginRegistry: registry },
      () => buildMediaUnderstandingCapabilityRegistry(config),
    );
    expect(capabilities.get(providerId)?.capabilities).toEqual(["audio"]);
    expect(fs.existsSync(unrelated.runtimeMarker)).toBe(false);
    expect(fs.existsSync(selected.runtimeMarker)).toBe(!active);
  },
);
