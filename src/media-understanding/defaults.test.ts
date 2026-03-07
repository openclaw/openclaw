import { describe, expect, it } from "vitest";
import {
  AUTO_AUDIO_KEY_PROVIDERS,
  AUTO_VIDEO_KEY_PROVIDERS,
  DEFAULT_AUDIO_MODELS,
} from "./defaults.js";

describe("DEFAULT_AUDIO_MODELS", () => {
  it("includes Mistral Voxtral default", () => {
    expect(DEFAULT_AUDIO_MODELS.mistral).toBe("voxtral-mini-latest");
  });

  it("includes Bailian Qwen ASR default", () => {
    expect(DEFAULT_AUDIO_MODELS.bailian).toBe("qwen3-asr-flash");
  });
});

describe("AUTO_AUDIO_KEY_PROVIDERS", () => {
  it("includes mistral auto key resolution", () => {
    expect(AUTO_AUDIO_KEY_PROVIDERS).toContain("mistral");
  });

  it("includes bailian auto key resolution", () => {
    expect(AUTO_AUDIO_KEY_PROVIDERS).toContain("bailian");
  });
});

describe("AUTO_VIDEO_KEY_PROVIDERS", () => {
  it("includes moonshot auto key resolution", () => {
    expect(AUTO_VIDEO_KEY_PROVIDERS).toContain("moonshot");
  });
});
