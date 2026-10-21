import { describe, expect, it } from "vitest";
import type { ModelAliasIndex } from "../agents/model-selection-shared.js";
import { withPluginMetadataSnapshotScope } from "../plugins/current-plugin-metadata-snapshot.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { resolveModelDirectiveSelection } from "./reply/model-selection-directive.js";

const emptyAliasIndex: ModelAliasIndex = { byAlias: new Map(), byKey: new Map() };
const kimi = { provider: "fixture-moonshot", model: "kimi-k2-0905-preview" };
const minimax = "fixture-minimax";
// Keep ranking fixtures independent of bundled provider policy loading.
const metadataSnapshot = createPluginMetadataSnapshotFixture();

function resolveModel(
  raw: string,
  allowedModelKeys: string[],
  overrides: {
    aliasIndex?: ModelAliasIndex;
    defaultProvider?: string;
    defaultModel?: string;
  } = {},
) {
  return withPluginMetadataSnapshotScope(metadataSnapshot, () =>
    resolveModelDirectiveSelection({
      raw,
      defaultProvider: "fixture-anthropic",
      defaultModel: "claude-opus-4-6",
      aliasIndex: emptyAliasIndex,
      ...overrides,
      allowedModelKeys: new Set(allowedModelKeys),
      cfg: { agents: { defaults: { modelPolicy: { allow: allowedModelKeys } } } },
    }),
  ).selection;
}

describe("directive behavior model fuzzy selection", () => {
  it("supports unambiguous fuzzy model matches across /model forms", () => {
    const allowedModelKeys = [
      "fixture-anthropic/claude-opus-4-6",
      "fixture-moonshot/kimi-k2-0905-preview",
    ];

    for (const raw of ["kimi", "kimi-k2-0905-preview", "fixture-moonshot/kimi"]) {
      expect(resolveModel(raw, allowedModelKeys)).toEqual({ ...kimi, isDefault: false });
    }
  });

  it("picks the best fuzzy match for global and provider-scoped fixture-minimax queries", () => {
    const defaults = { defaultProvider: minimax, defaultModel: "Fixture-Minimax-M2.7" };
    const allowedModelKeys = [
      "fixture-minimax/Fixture-Minimax-M2.7",
      "fixture-minimax/Fixture-Minimax-M2.7-highspeed",
    ];
    expect(
      resolveModel(
        "fixture-minimax",
        [...allowedModelKeys, "fixture-local/fixture-minimax-m2.5-gs32"],
        defaults,
      ),
    ).toEqual({ provider: minimax, model: "Fixture-Minimax-M2.7", isDefault: true });

    expect(resolveModel("fixture-minimax/highspeed", allowedModelKeys, defaults)).toEqual({
      provider: minimax,
      model: "Fixture-Minimax-M2.7-highspeed",
      isDefault: false,
    });
  });

  it("prefers alias matches when fuzzy selection is ambiguous", () => {
    const aliasIndex: ModelAliasIndex = {
      byAlias: new Map([["kimi", { alias: "Kimi", ref: kimi }]]),
      byKey: new Map([["fixture-moonshot/kimi-k2-0905-preview", ["Kimi"]]]),
    };

    expect(
      resolveModel(
        "ki",
        [
          "fixture-anthropic/claude-opus-4-6",
          "fixture-moonshot/kimi-k2-0905-preview",
          "fixture-local/kimi-k2-0905-preview",
        ],
        { aliasIndex },
      ),
    ).toEqual({ ...kimi, isDefault: false, alias: "Kimi" });
  });
});
