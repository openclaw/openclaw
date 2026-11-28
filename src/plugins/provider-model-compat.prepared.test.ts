import { describe, expect, it, vi } from "vitest";
import { attachModelProviderRequestRouteFacts } from "../agents/provider-request-config.js";
import type { Model } from "../llm/types.js";
import type { PluginMetadataSnapshotOwnerMaps } from "./plugin-metadata-snapshot.types.js";

const resolveProviderRequestCapabilities = vi.hoisted(() =>
  vi.fn(() => ({
    supportsDeveloperRole: false,
    supportsUsageInStreaming: false,
    supportsStrictMode: false,
  })),
);

vi.mock("../agents/provider-attribution.js", () => ({
  resolveProviderRequestCapabilities,
}));

import { buildCatalogModel } from "../plugin-sdk/provider-catalog.test-support.js";
import { makeEmptyPluginMetadataOwners } from "./plugin-metadata-empty.test-support.js";
import { normalizeModelCompat } from "./provider-model-compat.js";

function makeOwners(provider: string): PluginMetadataSnapshotOwnerMaps {
  return { ...makeEmptyPluginMetadataOwners(), providers: new Map([[provider, [provider]]]) };
}

const model = {
  ...buildCatalogModel("model", { name: "Model" }),
  provider: "custom",
  api: "openai-completions",
  baseUrl: "https://models.example/v1",
} as Model;

describe("normalizeModelCompat prepared metadata", () => {
  it("uses the exact owner generation supplied by its registry", () => {
    const firstOwners = makeOwners("first");
    const secondOwners = makeOwners("second");
    const firstModel = attachModelProviderRequestRouteFacts(model, firstOwners);
    const secondModel = attachModelProviderRequestRouteFacts(model, secondOwners);

    resolveProviderRequestCapabilities.mockClear();

    normalizeModelCompat(firstModel);
    normalizeModelCompat(secondModel);

    expect(resolveProviderRequestCapabilities).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ providerMetadataOwners: firstOwners }),
    );
    expect(resolveProviderRequestCapabilities).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ providerMetadataOwners: secondOwners }),
    );
  });
});
