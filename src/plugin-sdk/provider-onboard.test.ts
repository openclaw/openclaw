import { describe, expect, it } from "vitest";
import {
  applyOpencodeZenModelDefault,
  createAliasOnlyPresetAppliers,
  OPENCODE_ZEN_DEFAULT_MODEL,
  resolveAgentModelPrimaryValue,
  type OpenClawConfig,
} from "./provider-onboard.js";

function expectConfigUnchanged(
  applied: { changed: boolean; next: OpenClawConfig },
  cfg: OpenClawConfig,
) {
  expect(applied.changed).toBe(false);
  expect(applied.next).toEqual(cfg);
}

describe("createAliasOnlyPresetAppliers", () => {
  const modelRef = "example/default";
  const appliers = createAliasOnlyPresetAppliers({ modelRef, alias: "Example" });

  it("adds only the alias entry in provider-only mode", () => {
    const cfg: OpenClawConfig = {
      models: { mode: "merge", providers: {} },
      agents: { defaults: { models: { "other/model": { alias: "Other" } } } },
    };

    const result = appliers.applyProviderConfig(cfg);

    expect(result.models).toBe(cfg.models);
    expect(result.agents?.defaults?.model).toBeUndefined();
    expect(result.agents?.defaults?.models).toEqual({
      "other/model": { alias: "Other" },
      [modelRef]: { alias: "Example" },
    });
  });

  it("preserves entry fields and alias while replacing the primary", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          model: { primary: "old/model", fallbacks: ["fallback/model"] },
          models: { [modelRef]: { alias: "Custom", params: { temperature: 0.2 } } },
        },
      },
    };

    const result = appliers.applyConfig(cfg);

    expect(resolveAgentModelPrimaryValue(result.agents?.defaults?.model)).toBe(modelRef);
    expect(result.agents?.defaults?.model).toEqual({
      primary: modelRef,
      fallbacks: ["fallback/model"],
    });
    expect(result.agents?.defaults?.models?.[modelRef]).toEqual({
      alias: "Custom",
      params: { temperature: 0.2 },
    });
  });
});

describe("applyOpencodeZenModelDefault", () => {
  it("no-ops when already legacy opencode-zen default", () => {
    const cfg = {
      agents: { defaults: { model: "opencode-zen/claude-opus-4-5" } },
    } as OpenClawConfig;
    const applied = applyOpencodeZenModelDefault(cfg);
    expectConfigUnchanged(applied, cfg);
  });

  it("preserves fallbacks when setting primary", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          model: {
            primary: "anthropic/claude-opus-4-6",
            fallbacks: ["google/gemini-3-pro"],
          },
        },
      },
    };
    const applied = applyOpencodeZenModelDefault(cfg);
    expect(applied.changed).toBe(true);
    expect(applied.next.agents?.defaults?.model).toEqual({
      primary: OPENCODE_ZEN_DEFAULT_MODEL,
      fallbacks: ["google/gemini-3.1-pro-preview"],
    });
  });
});
