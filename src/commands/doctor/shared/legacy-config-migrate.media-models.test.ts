import { describe, expect, it } from "vitest";
import type { OpenClawConfigWithLegacyRoster } from "../../../config/legacy.roster.js";
import { migrateLegacyConfigForTest } from "./legacy-config-migrate.apply.test-support.js";

describe("legacy model compat migrate", () => {
  it.each([true, false])(
    "preserves model selections matching retirement patterns (catalog present: %s)",
    (catalogPresent) => {
      const model = {
        primary: "openai/gpt-4.1-mini@openai:work",
        fallbacks: [
          "anthropic/claude-sonnet-4-20250514",
          "github-copilot/gpt-4o",
          "groq/llama3-70b-8192",
          "xai/grok-code-fast-1",
        ],
      };
      const models = { "openai/gpt-4.1-mini": { alias: "small", params: { temperature: 0.2 } } };
      const raw = {
        agents: { defaults: { model, models } },
        ...(catalogPresent
          ? {
              models: {
                providers: {
                  openai: { models: [{ id: "gpt-4.1-mini", name: "Served model" }] },
                },
              },
            }
          : {}),
      };
      const result = migrateLegacyConfigForTest(raw);
      const config = result.config ?? raw;

      expect(config.agents?.defaults?.model).toEqual(model);
      expect(config.agents?.defaults?.models).toEqual(models);
      expect(config.models).toEqual(raw.models);
    },
  );

  it("moves media selections without replacing model choices", () => {
    const raw: OpenClawConfigWithLegacyRoster = {
      agents: {
        defaults: {
          imageGenerationModel: {
            primary: "xai/grok-imagine-image-pro",
            fallbacks: ["xai/grok-imagine-image"],
          },
          model: {
            primary: "xai/grok-4.20-beta-latest-reasoning",
          },
          models: {
            "xai/grok-imagine-image-pro": { alias: "quality" },
          },
        },
      },
    };

    const res = migrateLegacyConfigForTest(raw);

    expect(res.config?.agents?.defaults?.mediaModels?.image).toEqual({
      primary: "xai/grok-imagine-image-pro",
      fallbacks: ["xai/grok-imagine-image"],
    });
    expect(res.config?.agents?.defaults?.model).toEqual({
      primary: "xai/grok-4.20-beta-latest-reasoning",
    });
    expect(res.config?.agents?.defaults?.models).toEqual({
      "xai/grok-imagine-image-pro": { alias: "quality" },
    });
  });
});
