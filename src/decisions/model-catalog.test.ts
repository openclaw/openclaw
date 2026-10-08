import { describe, expect, it } from "vitest";
import { buildConfiguredModelCatalog } from "../agents/model-selection-shared.js";
import { materializeConfiguredProviderCatalogModels } from "../agents/models-config.providers.catalog.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { listDecisionModels } from "./model-catalog.js";

const model = {
  id: "custom",
  name: "Custom classifier",
  reasoning: false,
  input: ["text" as const],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  maxTokens: 1,
};
const config: OpenClawConfig = {
  models: {
    providers: {
      judge: {
        type: "decision",
        decisionProvider: "typesafe",
        baseUrl: "https://decision.example.test",
        models: [model],
      },
      chat: { baseUrl: "https://chat.example.test", models: [model] },
    },
  },
};
const snapshot = createPluginMetadataSnapshotFixture({
  plugins: [
    {
      id: "decision-plugin",
      contracts: { decisionProviders: ["typesafe"] },
      decisionModels: [{ provider: "typesafe", id: "known", name: "Known classifier" }],
    },
  ],
});

describe("decision model catalog", () => {
  it("exposes configured decision models through their available adapter owner", () => {
    expect(listDecisionModels({ config, snapshot })).toEqual([
      { provider: "typesafe", id: "known", name: "Known classifier", pluginId: "decision-plugin" },
      { provider: "judge", id: "custom", name: "Custom classifier", pluginId: "decision-plugin" },
    ]);
  });

  it("does not advertise configured models whose adapter is disabled or missing", () => {
    expect(
      listDecisionModels({
        config: { ...config, plugins: { entries: { "decision-plugin": { enabled: false } } } },
        snapshot,
      }),
    ).toEqual([]);
    expect(listDecisionModels({ config, snapshot: createPluginMetadataSnapshotFixture() })).toEqual(
      [],
    );
    expect(
      listDecisionModels({ config: { ...config, plugins: { enabled: false } }, snapshot }),
    ).toEqual([]);
  });

  it("keeps decision endpoints out of materialized chat provider catalogs", () => {
    const providers = materializeConfiguredProviderCatalogModels(config.models?.providers);
    expect(Object.keys(providers ?? {})).toEqual(["chat"]);
    expect(providers?.judge).toBeUndefined();
    expect(
      buildConfiguredModelCatalog({ cfg: config, manifestPlugins: snapshot }).map(
        (entry) => entry.provider,
      ),
    ).toEqual(["chat"]);
  });
});
