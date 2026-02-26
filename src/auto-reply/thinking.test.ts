import { describe, expect, it } from "vitest";
import {
  formatEffortLevels,
  listEffortLevels,
  listThinkingLevelLabels,
  listThinkingLevels,
  normalizeEffortLevel,
  normalizeReasoningLevel,
  normalizeThinkLevel,
  supportsEffort,
  supportsMaxEffort,
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

  it("includes xhigh for openai gpt-5.2 and gpt-5.4 variants", () => {
    expect(listThinkingLevels("openai", "gpt-5.2")).toContain("xhigh");
    expect(listThinkingLevels("openai", "gpt-5.4")).toContain("xhigh");
    expect(listThinkingLevels("openai", "gpt-5.4-pro")).toContain("xhigh");
  });

  it("includes xhigh for openai-codex gpt-5.4", () => {
    expect(listThinkingLevels("openai-codex", "gpt-5.4")).toContain("xhigh");
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

describe("normalizeEffortLevel", () => {
  it("returns undefined for empty input", () => {
    expect(normalizeEffortLevel(undefined)).toBeUndefined();
    expect(normalizeEffortLevel(null)).toBeUndefined();
    expect(normalizeEffortLevel("")).toBeUndefined();
  });

  it("normalizes off aliases", () => {
    expect(normalizeEffortLevel("off")).toBe("off");
    expect(normalizeEffortLevel("none")).toBe("off");
    expect(normalizeEffortLevel("disable")).toBe("off");
    expect(normalizeEffortLevel("disabled")).toBe("off");
    expect(normalizeEffortLevel("default")).toBe("off");
  });

  it("normalizes low aliases", () => {
    expect(normalizeEffortLevel("low")).toBe("low");
    expect(normalizeEffortLevel("min")).toBe("low");
    expect(normalizeEffortLevel("minimal")).toBe("low");
  });

  it("normalizes medium aliases", () => {
    expect(normalizeEffortLevel("medium")).toBe("medium");
    expect(normalizeEffortLevel("mid")).toBe("medium");
    expect(normalizeEffortLevel("med")).toBe("medium");
  });

  it("normalizes high", () => {
    expect(normalizeEffortLevel("high")).toBe("high");
  });

  it("normalizes max aliases", () => {
    expect(normalizeEffortLevel("max")).toBe("max");
    expect(normalizeEffortLevel("maximum")).toBe("max");
  });

  it("is case-insensitive", () => {
    expect(normalizeEffortLevel("HIGH")).toBe("high");
    expect(normalizeEffortLevel("Max")).toBe("max");
    expect(normalizeEffortLevel("  LOW  ")).toBe("low");
  });

  it("returns undefined for unknown strings", () => {
    expect(normalizeEffortLevel("banana")).toBeUndefined();
    expect(normalizeEffortLevel("ultra")).toBeUndefined();
  });
});

describe("supportsMaxEffort", () => {
  it("returns true for Opus 4.6 models", () => {
    expect(supportsMaxEffort(undefined, "claude-opus-4-6")).toBe(true);
    expect(supportsMaxEffort(undefined, "claude-opus-4.6")).toBe(true);
    expect(supportsMaxEffort("anthropic", "claude-opus-4-6-20260101")).toBe(true);
  });

  it("returns false for non-Opus models", () => {
    expect(supportsMaxEffort(undefined, "claude-sonnet-4-6")).toBe(false);
    expect(supportsMaxEffort(undefined, "claude-sonnet-4.5")).toBe(false);
    expect(supportsMaxEffort(undefined, "gpt-4.1")).toBe(false);
  });

  it("returns false for undefined model", () => {
    expect(supportsMaxEffort(undefined, undefined)).toBe(false);
    expect(supportsMaxEffort(undefined, null)).toBe(false);
  });
});

describe("supportsEffort", () => {
  it("returns true for Anthropic 4.6 family models", () => {
    expect(supportsEffort("anthropic", "claude-opus-4-6")).toBe(true);
    expect(supportsEffort("anthropic", "claude-sonnet-4-6")).toBe(true);
    expect(supportsEffort("anthropic", "claude-sonnet-4.6")).toBe(true);
    expect(supportsEffort("anthropic", "claude-opus-4-6-20260101")).toBe(true);
  });

  it("returns false for non-Anthropic providers", () => {
    expect(supportsEffort("openai", "claude-opus-4-6")).toBe(false);
    expect(supportsEffort(undefined, "claude-opus-4-6")).toBe(false);
  });

  it("returns false for non-4.6 Anthropic models", () => {
    expect(supportsEffort("anthropic", "claude-sonnet-4-5")).toBe(false);
    expect(supportsEffort("anthropic", "claude-sonnet-4.5")).toBe(false);
    expect(supportsEffort("anthropic", "claude-3-5-sonnet")).toBe(false);
    expect(supportsEffort("anthropic", "claude-3-opus")).toBe(false);
  });

  it("returns false for undefined model", () => {
    expect(supportsEffort("anthropic", undefined)).toBe(false);
    expect(supportsEffort("anthropic", null)).toBe(false);
  });
});

describe("listEffortLevels", () => {
  it("includes max for Opus 4.6", () => {
    expect(listEffortLevels(undefined, "claude-opus-4-6")).toContain("max");
  });

  it("excludes max for non-Opus models", () => {
    expect(listEffortLevels(undefined, "claude-sonnet-4-6")).not.toContain("max");
  });

  it("always includes off, low, medium, high", () => {
    const levels = listEffortLevels(undefined, "claude-sonnet-4-6");
    expect(levels).toEqual(["off", "low", "medium", "high"]);
  });
});

describe("formatEffortLevels", () => {
  it("joins with default separator", () => {
    expect(formatEffortLevels(undefined, "claude-sonnet-4-6")).toBe("off, low, medium, high");
  });

  it("includes max for Opus 4.6", () => {
    expect(formatEffortLevels(undefined, "claude-opus-4-6")).toBe("off, low, medium, high, max");
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
