import { describe, expect, it } from "vitest";
import { resolveLiveModels } from "../../scripts/e2e/lib/upgrade-survivor/live-models.mjs";

const keys = {
  OPENAI_API_KEY: "fixture-openai",
  ANTHROPIC_API_KEY: "fixture-anthropic",
  GEMINI_API_KEY: "fixture-google",
};

describe("upgrade survivor live model selection", () => {
  it("parses whitespace-separated refs and selects only their provider keys", () => {
    const selection = resolveLiveModels({
      ...keys,
      OPENCLAW_UPGRADE_SURVIVOR_LIVE_MODELS:
        " \topenai/gpt-5.5\nanthropic/claude-opus-5  google/gemini-3.1-pro-preview ",
    });
    expect(selection.source).toBe("OPENCLAW_UPGRADE_SURVIVOR_LIVE_MODELS");
    expect(selection.models).toEqual([
      {
        model: "openai/gpt-5.5",
        provider: "openai",
        keyEnv: "OPENAI_API_KEY",
        artifact: "live-openai",
      },
      {
        model: "anthropic/claude-opus-5",
        provider: "anthropic",
        keyEnv: "ANTHROPIC_API_KEY",
        artifact: "live-anthropic",
      },
      {
        model: "google/gemini-3.1-pro-preview",
        provider: "google",
        keyEnv: "GEMINI_API_KEY",
        artifact: "live-google",
      },
    ]);
    expect(JSON.stringify(selection)).not.toContain("fixture-");
  });

  it("preserves legacy defaults and overrides, with explicit models taking precedence", () => {
    expect(resolveLiveModels({}).models).toEqual([]);
    const legacy = { ...keys, OPENCLAW_UPGRADE_SURVIVOR_LIVE_OPENAI: "1" };
    expect(resolveLiveModels(legacy)).toMatchObject({
      source: "OPENCLAW_UPGRADE_SURVIVOR_LIVE_OPENAI",
      overridesLiveOpenai: false,
      models: [{ model: "openai/gpt-5.5", artifact: "live-openai" }],
    });
    expect(
      resolveLiveModels({
        ...legacy,
        OPENCLAW_UPGRADE_SURVIVOR_LIVE_OPENAI_MODEL: "openai/gpt-4.1",
      }).models[0]?.model,
    ).toBe("openai/gpt-4.1");
    expect(
      resolveLiveModels({
        ...legacy,
        OPENAI_API_KEY: "",
        OPENCLAW_UPGRADE_SURVIVOR_LIVE_MODELS: "google/gemini-3.1-pro-preview",
      }),
    ).toMatchObject({ overridesLiveOpenai: true, models: [{ provider: "google" }] });
  });

  it.each([
    ["openai/gpt-5.5", "OPENAI_API_KEY"],
    ["anthropic/claude-opus-5", "ANTHROPIC_API_KEY"],
    ["google/gemini-3.1-pro-preview", "GEMINI_API_KEY"],
  ])("fails clearly when %s has no key", (model, keyEnv) => {
    expect(() =>
      resolveLiveModels({
        ...keys,
        [keyEnv]: " ",
        OPENCLAW_UPGRADE_SURVIVOR_LIVE_MODELS: model,
      }),
    ).toThrow(`Live model ${model} requires ${keyEnv}`);
  });

  it.each([" \t\n", "gpt-5.5", "unknown/model", "openai/gpt-5.5 openai/gpt-5.5"])(
    "rejects invalid or duplicate selections: %j",
    (models) => {
      expect(() =>
        resolveLiveModels({ ...keys, OPENCLAW_UPGRADE_SURVIVOR_LIVE_MODELS: models }),
      ).toThrow();
    },
  );

  it("keeps distinct artifacts and sessions for multiple models from one provider", () => {
    expect(
      resolveLiveModels({
        ...keys,
        OPENCLAW_UPGRADE_SURVIVOR_LIVE_MODELS: "openai/gpt-5.5 openai/gpt-4.1",
      }).models.map(({ artifact }) => artifact),
    ).toEqual(["live-openai", "live-openai-2"]);
  });
});
