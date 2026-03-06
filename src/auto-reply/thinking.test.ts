import { describe, expect, it } from "vitest";
import {
  isGlmModel,
  listThinkingLevelLabels,
  listThinkingLevels,
  normalizeReasoningLevel,
  normalizeReasoningLevelForGlm,
  normalizeThinkLevel,
} from "./thinking.js";

describe("normalizeThinkLevel", () => {
  it("accepts mid as medium", () => {
    expect(normalizeThinkLevel("mid")).toBe("medium");
  });

  it("accepts xhigh aliases", () => {
    expect(normalizeThinkLevel("xhigh")).toBe("xhigh");
    expect(normalizeThinkLevel("x-high")).toBe("xhigh");
    expect(normalizeThinkLevel("x_high")).toBe("xhigh");
    expect(normalizeThinkLevel("x high")).toBe("xhigh");
  });

  it("accepts extra-high aliases as xhigh", () => {
    expect(normalizeThinkLevel("extra-high")).toBe("xhigh");
    expect(normalizeThinkLevel("extra high")).toBe("xhigh");
    expect(normalizeThinkLevel("extra_high")).toBe("xhigh");
    expect(normalizeThinkLevel("  extra high  ")).toBe("xhigh");
  });

  it("does not over-match nearby xhigh words", () => {
    expect(normalizeThinkLevel("extra-highest")).toBeUndefined();
    expect(normalizeThinkLevel("xhigher")).toBeUndefined();
  });

  it("accepts on as low", () => {
    expect(normalizeThinkLevel("on")).toBe("low");
  });

  it("accepts adaptive and auto aliases", () => {
    expect(normalizeThinkLevel("adaptive")).toBe("adaptive");
    expect(normalizeThinkLevel("auto")).toBe("adaptive");
    expect(normalizeThinkLevel("Adaptive")).toBe("adaptive");
  });
});

describe("listThinkingLevels", () => {
  it("includes xhigh for codex models", () => {
    expect(listThinkingLevels(undefined, "gpt-5.2-codex")).toContain("xhigh");
    expect(listThinkingLevels(undefined, "gpt-5.3-codex")).toContain("xhigh");
    expect(listThinkingLevels(undefined, "gpt-5.3-codex-spark")).toContain("xhigh");
  });

  it("includes xhigh for openai gpt-5.2", () => {
    expect(listThinkingLevels("openai", "gpt-5.2")).toContain("xhigh");
  });

  it("includes xhigh for github-copilot gpt-5.2 refs", () => {
    expect(listThinkingLevels("github-copilot", "gpt-5.2")).toContain("xhigh");
    expect(listThinkingLevels("github-copilot", "gpt-5.2-codex")).toContain("xhigh");
  });

  it("excludes xhigh for non-codex models", () => {
    expect(listThinkingLevels(undefined, "gpt-4.1-mini")).not.toContain("xhigh");
  });

  it("always includes adaptive", () => {
    expect(listThinkingLevels(undefined, "gpt-4.1-mini")).toContain("adaptive");
    expect(listThinkingLevels("anthropic", "claude-opus-4-6")).toContain("adaptive");
  });
});

describe("listThinkingLevelLabels", () => {
  it("returns on/off for ZAI", () => {
    expect(listThinkingLevelLabels("zai", "glm-4.7")).toEqual(["off", "on"]);
  });

  it("returns full levels for non-ZAI", () => {
    expect(listThinkingLevelLabels("openai", "gpt-4.1-mini")).toContain("low");
    expect(listThinkingLevelLabels("openai", "gpt-4.1-mini")).not.toContain("on");
  });
});

describe("normalizeReasoningLevel", () => {
  it("accepts on/off", () => {
    expect(normalizeReasoningLevel("on")).toBe("on");
    expect(normalizeReasoningLevel("off")).toBe("off");
  });

  it("accepts show/hide", () => {
    expect(normalizeReasoningLevel("show")).toBe("on");
    expect(normalizeReasoningLevel("hide")).toBe("off");
  });

  it("accepts stream", () => {
    expect(normalizeReasoningLevel("stream")).toBe("stream");
    expect(normalizeReasoningLevel("streaming")).toBe("stream");
  });
});

describe("isGlmModel", () => {
  it("returns true for zai provider", () => {
    expect(isGlmModel("zai", "glm-4.7")).toBe(true);
    expect(isGlmModel("z.ai", "anything")).toBe(true);
  });

  it("returns true when model id contains glm", () => {
    expect(isGlmModel("lmstudio", "glm-4.7-flash")).toBe(true);
    expect(isGlmModel("openai", "glm-4.7")).toBe(true);
  });

  it("returns false for non-GLM provider and model", () => {
    expect(isGlmModel("openai", "gpt-4.1-mini")).toBe(false);
    expect(isGlmModel("lmstudio", "llama-3")).toBe(false);
  });

  it("returns false when model id is empty", () => {
    expect(isGlmModel("lmstudio", "")).toBe(false);
    expect(isGlmModel(undefined, undefined)).toBe(false);
  });
});

describe("normalizeReasoningLevelForGlm", () => {
  it("maps off to off", () => {
    expect(normalizeReasoningLevelForGlm("off")).toBe("off");
    expect(normalizeReasoningLevelForGlm(undefined)).toBe("off");
  });

  it("maps all non-off to on", () => {
    expect(normalizeReasoningLevelForGlm("on")).toBe("on");
    expect(normalizeReasoningLevelForGlm("stream")).toBe("on");
  });
});
