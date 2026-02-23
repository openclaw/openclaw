import { describe, expect, it } from "vitest";
import { AUTO_AUDIO_KEY_PROVIDERS, DEFAULT_AUDIO_MODELS } from "./defaults.js";

describe("DEFAULT_AUDIO_MODELS", () => {
  it("includes Mistral Voxtral default", () => {
    expect(DEFAULT_AUDIO_MODELS.mistral).toBe("voxtral-mini-latest");
  });
});

describe("AUTO_AUDIO_KEY_PROVIDERS", () => {
  it("includes mistral auto key resolution", () => {
    expect(AUTO_AUDIO_KEY_PROVIDERS).toContain("mistral");
  });
});
