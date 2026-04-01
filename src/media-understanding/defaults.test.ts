import { describe, expect, it } from "vitest";
import {
  AUTO_AUDIO_KEY_PROVIDERS,
  AUTO_IMAGE_KEY_PROVIDERS,
  AUTO_VIDEO_KEY_PROVIDERS,
  DEFAULT_AUDIO_MODELS,
  DEFAULT_IMAGE_MODELS,
} from "./defaults.js";

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

describe("AUTO_VIDEO_KEY_PROVIDERS", () => {
  it("includes moonshot auto key resolution", () => {
    expect(AUTO_VIDEO_KEY_PROVIDERS).toContain("moonshot");
  });
});

describe("AUTO_IMAGE_KEY_PROVIDERS", () => {
  it("includes minimax-portal auto key resolution", () => {
    expect(AUTO_IMAGE_KEY_PROVIDERS).toContain("minimax-portal");
  });
});

describe("DEFAULT_IMAGE_MODELS", () => {
  it("includes the MiniMax portal vision default", () => {
    expect(DEFAULT_IMAGE_MODELS["minimax-portal"]).toBe("MiniMax-VL-01");
  });

  it("includes bundled image-provider defaults beyond the core provider set", () => {
    expect(DEFAULT_IMAGE_MODELS["openai-codex"]).toBe("gpt-5.4");
    expect(DEFAULT_IMAGE_MODELS.moonshot).toBe("kimi-k2.5");
    expect(DEFAULT_IMAGE_MODELS.openrouter).toBe("auto");
  });
});
