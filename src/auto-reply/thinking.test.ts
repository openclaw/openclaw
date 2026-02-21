import { describe, expect, it } from "vitest";
import {
  listThinkingLevelLabels,
  listThinkingLevels,
  normalizeReasoningLevel,
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
