import { normalizeConfiguredProviderCatalogModelId } from "@openclaw/model-catalog-core/provider-model-id-normalization";
import { afterEach, beforeEach, expect, it } from "vitest";
import { normalizeStaticProviderModelId } from "../agents/model-ref-shared.js";
import { withPluginMetadataSnapshotScope } from "./current-plugin-metadata-snapshot.js";
import { setCurrentPluginMetadataSnapshot } from "./current-plugin-metadata.test-support.js";
import { clearPluginMetadataLifecycleCaches } from "./plugin-metadata-lifecycle.js";
import {
  projectPluginMetadataSnapshot,
  restorePluginMetadataSnapshot,
} from "./plugin-metadata-snapshot.js";
import { createPluginMetadataSnapshotFixture } from "./plugin-metadata.test-support.js";
import { resetPluginRuntimeStateForTest } from "./runtime.js";

function reset() {
  resetPluginRuntimeStateForTest();
  clearPluginMetadataLifecycleCaches();
}
beforeEach(reset);
afterEach(reset);

it("does not reuse broader normalization policies in a narrowed metadata view", () => {
  const snapshot = restorePluginMetadataSnapshot(
    createPluginMetadataSnapshotFixture({
      plugins: [
        {
          id: "normalizer",
          providers: ["demo"],
          modelIdNormalization: { providers: { demo: { prefixWhenBare: "scoped" } } },
        },
      ],
    }),
  );
  const narrowed = projectPluginMetadataSnapshot(snapshot, []);
  setCurrentPluginMetadataSnapshot(snapshot, { config: {}, env: process.env });
  const normalize = (view: typeof snapshot) =>
    withPluginMetadataSnapshotScope(
      view,
      () => normalizeStaticProviderModelId("demo", "demo-model"),
      {
        trustConfigIdentity: true,
      },
    );
  expect(normalize(snapshot)).toBe("scoped/demo-model");
  expect(normalize(narrowed)).toBe("demo-model");
  expect(normalizeConfiguredProviderCatalogModelId("demo", "demo-model")).toBe("scoped/demo-model");
  expect(
    normalizeConfiguredProviderCatalogModelId(
      "demo",
      "demo-model",
      narrowed.owners.modelIdNormalizationPolicies,
    ),
  ).toBe("demo-model");
  expect(normalize(snapshot)).toBe("scoped/demo-model");
});
