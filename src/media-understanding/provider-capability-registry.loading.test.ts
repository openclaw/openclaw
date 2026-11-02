import { expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { withPluginRuntimeGenerationScope } from "../plugins/runtime/generation-scope.js";
import { mediaModels } from "./media-config.test-support.js";
import { buildMediaUnderstandingCapabilityRegistry } from "./provider-capability-registry.js";

it("infers only untagged entries and lets runtime audio metadata override configured image fallback", () => {
  const ids = ["google", "unrelated"];
  const pluginRegistry = createEmptyPluginRegistry();
  for (const id of ids) {
    pluginRegistry.mediaUnderstandingProviders.push({
      pluginId: id,
      source: "test",
      provider: { id, capabilities: ["audio"] },
    });
  }
  const metadataSnapshot = createPluginMetadataSnapshotFixture({
    plugins: ids.map((id) => ({ id, contracts: { mediaUnderstandingProviders: [id] } })),
  });
  const cfg: OpenClawConfig = {
    plugins: { allow: ids },
    models: mediaModels("google", "fixture-image", ["text", "image"]),
    tools: {
      media: {
        models: [
          { provider: " GEMINI ", capabilities: ["image"] },
          { provider: "unrelated", capabilities: ["audio"] },
          { provider: " GEMINI " },
        ],
      },
    },
  };
  const registry = withPluginRuntimeGenerationScope({ metadataSnapshot, pluginRegistry }, () =>
    buildMediaUnderstandingCapabilityRegistry(cfg),
  );
  expect([...registry.keys()]).toEqual(["google"]);
  expect(registry.get("google")?.capabilities).toEqual(["audio"]);
});
