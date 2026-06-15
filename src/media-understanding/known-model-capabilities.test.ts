import { describe, expect, it } from "vitest";
import { isKnownNonImageModel } from "./known-model-capabilities.js";

describe("known model capabilities", () => {
  it("preserves local model ids that contain slashes", () => {
    expect(
      isKnownNonImageModel({
        modelId: "openrouter/meta-llama/llama-4-scout",
        provider: {
          id: "openrouter",
          modelCapabilityOverrides: {
            nonImageModels: ["openrouter/meta-llama/llama-4-scout"],
          },
        },
      }),
    ).toBe(true);
    expect(
      isKnownNonImageModel({
        modelId: "openrouter/openai/gpt-5.4",
        provider: {
          id: "openrouter",
          modelCapabilityOverrides: {
            nonImageModels: ["anthropic/gpt-5.4"],
          },
        },
      }),
    ).toBe(false);
  });
});
