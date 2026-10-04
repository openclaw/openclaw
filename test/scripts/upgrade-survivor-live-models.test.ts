import { describe, expect, it } from "vitest";
import { resolveLiveModels } from "../../scripts/e2e/lib/upgrade-survivor/live-models.mjs";

const keys = {
  OPENAI_API_KEY: "fixture-openai",
  ANTHROPIC_API_KEY: "fixture-anthropic",
  GEMINI_API_KEY: "fixture-google",
};

describe("upgrade survivor live model selection", () => {
  it("selects provider keys and unique artifacts without leaking credentials", () => {
    const selection = resolveLiveModels({
      ...keys,
      OPENCLAW_UPGRADE_SURVIVOR_LIVE_MODELS:
        " \topenai/gpt-5.5\nanthropic/claude-opus-5  google/gemini-3.1-pro-preview openai/gpt-4.1 ",
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
      {
        model: "openai/gpt-4.1",
        provider: "openai",
        keyEnv: "OPENAI_API_KEY",
        artifact: "live-openai-2",
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
    { models: " \t\n" },
    { models: "gpt-5.5" },
    { models: "openai/gpt-5.5 openai/gpt-5.5" },
    {
      models: "openai/gpt-5.5",
      key: " ",
      error: "Live model openai/gpt-5.5 requires OPENAI_API_KEY",
    },
  ])(
    "rejects invalid selections or credentials: $models",
    ({ models, key = keys.OPENAI_API_KEY, error }) => {
      expect(() =>
        resolveLiveModels({
          ...keys,
          OPENAI_API_KEY: key,
          OPENCLAW_UPGRADE_SURVIVOR_LIVE_MODELS: models,
        }),
      ).toThrow(error);
    },
  );
});
