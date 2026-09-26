/** Tests fuzzy /model directive matching and ambiguous alias handling. */
import { describe, expect, it } from "vitest";
import type { ModelAliasIndex } from "../agents/model-selection-shared.js";
import { withPluginMetadataSnapshotScope } from "../plugins/current-plugin-metadata-snapshot.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { resolveModelDirectiveSelection } from "./reply/model-selection-directive.js";

const emptyAliasIndex: ModelAliasIndex = {
  byAlias: new Map(),
  byKey: new Map(),
};
// Keep ranking fixtures independent of bundled provider policy loading.
const metadataSnapshot = createPluginMetadataSnapshotFixture();

function resolveModel(
  raw: string,
  params?: {
    allowedModelKeys?: string[];
    aliasIndex?: ModelAliasIndex;
    defaultProvider?: string;
    defaultModel?: string;
  },
) {
  return withPluginMetadataSnapshotScope(metadataSnapshot, () =>
    resolveModelDirectiveSelection({
      raw,
      defaultProvider: params?.defaultProvider ?? "fixture-anthropic",
      defaultModel: params?.defaultModel ?? "claude-opus-4-6",
      aliasIndex: params?.aliasIndex ?? emptyAliasIndex,
      allowedModelKeys: new Set(params?.allowedModelKeys ?? []),
      cfg: { agents: { defaults: { modelPolicy: { allow: params?.allowedModelKeys ?? [] } } } },
    }),
  );
}

describe("directive behavior model fuzzy selection", () => {
  it("supports unambiguous fuzzy model matches across /model forms", () => {
    const allowedModelKeys = [
      "fixture-anthropic/claude-opus-4-6",
      "fixture-moonshot/kimi-k2-0905-preview",
    ];

    for (const raw of ["kimi", "kimi-k2-0905-preview", "fixture-moonshot/kimi"]) {
      expect(resolveModel(raw, { allowedModelKeys }).selection).toEqual({
        provider: "fixture-moonshot",
        model: "kimi-k2-0905-preview",
        isDefault: false,
      });
    }
  });

  it("picks the best fuzzy match for global and provider-scoped fixture-minimax queries", () => {
    expect(
      resolveModel("fixture-minimax", {
        defaultProvider: "fixture-minimax",
        defaultModel: "Fixture-Minimax-M2.7",
        allowedModelKeys: [
          "fixture-minimax/Fixture-Minimax-M2.7",
          "fixture-minimax/Fixture-Minimax-M2.7-highspeed",
          "fixture-local/fixture-minimax-m2.5-gs32",
        ],
      }).selection,
    ).toEqual({
      provider: "fixture-minimax",
      model: "Fixture-Minimax-M2.7",
      isDefault: true,
    });

    expect(
      resolveModel("fixture-minimax/highspeed", {
        defaultProvider: "fixture-minimax",
        defaultModel: "Fixture-Minimax-M2.7",
        allowedModelKeys: [
          "fixture-minimax/Fixture-Minimax-M2.7",
          "fixture-minimax/Fixture-Minimax-M2.7-highspeed",
        ],
      }).selection,
    ).toEqual({
      provider: "fixture-minimax",
      model: "Fixture-Minimax-M2.7-highspeed",
      isDefault: false,
    });
  });

  it("prefers alias matches when fuzzy selection is ambiguous", () => {
    const aliasIndex: ModelAliasIndex = {
      byAlias: new Map([
        [
          "kimi",
          {
            alias: "Kimi",
            ref: { provider: "fixture-moonshot", model: "kimi-k2-0905-preview" },
          },
        ],
      ]),
      byKey: new Map([["fixture-moonshot/kimi-k2-0905-preview", ["Kimi"]]]),
    };

    expect(
      resolveModel("ki", {
        aliasIndex,
        allowedModelKeys: [
          "fixture-anthropic/claude-opus-4-6",
          "fixture-moonshot/kimi-k2-0905-preview",
          "fixture-local/kimi-k2-0905-preview",
        ],
      }).selection,
    ).toEqual({
      provider: "fixture-moonshot",
      model: "kimi-k2-0905-preview",
      isDefault: false,
      alias: "Kimi",
    });
  });
});
