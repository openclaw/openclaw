import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { DEFAULT_IMAGE_MODELS } from "../media-understanding/defaults.js";
import { resolveAutoImageModel } from "./media-runtime-auto.js";
import { buildExtensionHostMediaUnderstandingRegistry } from "./media-runtime-registry.js";

function createImageCfg(): OpenClawConfig {
  return {
    models: {
      providers: {
        openai: {
          apiKey: "test-key",
          models: [],
        },
      },
    },
  } as unknown as OpenClawConfig;
}

describe("media runtime auto image model", () => {
  it("keeps a valid active image model", async () => {
    const result = await resolveAutoImageModel({
      cfg: createImageCfg(),
      providerRegistry: buildExtensionHostMediaUnderstandingRegistry(),
      activeModel: {
        provider: "openai",
        model: "gpt-4.1-mini",
      },
    });

    expect(result).toEqual({
      provider: "openai",
      model: "gpt-4.1-mini",
    });
  });

  it("falls back to the default keyed image model when the active model cannot be used", async () => {
    const result = await resolveAutoImageModel({
      cfg: createImageCfg(),
      providerRegistry: buildExtensionHostMediaUnderstandingRegistry(),
      activeModel: {
        provider: "missing-provider",
        model: "ignored",
      },
    });

    expect(result).toEqual({
      provider: "openai",
      model: DEFAULT_IMAGE_MODELS.openai,
    });
  });
});
