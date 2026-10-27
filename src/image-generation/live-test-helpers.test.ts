import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { resolveConfiguredLiveImageModels } from "./live-test-helpers.js";

describe("image-generation live-test helpers", () => {
  it("collects configured models from primary and fallbacks", () => {
    const cfg = {
      agents: {
        defaults: {
          mediaModels: {
            image: {
              primary: "openai/gpt-image-2",
              fallbacks: ["google/gemini-3.1-flash-image-preview", "invalid"],
            },
          },
        },
      },
    } as OpenClawConfig;

    expect(resolveConfiguredLiveImageModels(cfg)).toEqual(
      new Map([
        ["openai", "openai/gpt-image-2"],
        ["google", "google/gemini-3.1-flash-image-preview"],
      ]),
    );
  });
});
