import { describe, expect, it } from "vitest";
import {
  formatEffectiveThinkingResolution,
  listThinkingLevelLabels,
  listThinkingLevels,
  normalizeReasoningLevel,
  normalizeThinkLevel,
  resolveThinkingDefaultForModel,
  resolveEffectiveThinking,
  resolveThinkingCapabilities,
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

  it("accepts ZAI provider aliases", () => {
    expect(listThinkingLevelLabels("z.ai", "glm-4.7")).toEqual(["off", "on"]);
    expect(listThinkingLevelLabels("z-ai", "glm-4.7")).toEqual(["off", "on"]);
  });

  it("returns full levels for non-ZAI", () => {
    expect(listThinkingLevelLabels("openai", "gpt-4.1-mini")).toContain("low");
    expect(listThinkingLevelLabels("openai", "gpt-4.1-mini")).not.toContain("on");
  });
});

describe("resolveThinkingDefaultForModel", () => {
  it("defaults Claude 4.6 models to adaptive", () => {
    expect(
      resolveThinkingDefaultForModel({ provider: "anthropic", model: "claude-opus-4-6" }),
    ).toBe("adaptive");
  });

  it("treats Bedrock Anthropic aliases as adaptive", () => {
    expect(
      resolveThinkingDefaultForModel({ provider: "aws-bedrock", model: "claude-sonnet-4-6" }),
    ).toBe("adaptive");
  });

  it("defaults reasoning-capable catalog models to low", () => {
    expect(
      resolveThinkingDefaultForModel({
        provider: "openai",
        model: "gpt-5.4",
        catalog: [{ provider: "openai", id: "gpt-5.4", reasoning: true }],
      }),
    ).toBe("low");
  });

  it("defaults to off when no adaptive or reasoning hint is present", () => {
    expect(
      resolveThinkingDefaultForModel({
        provider: "openai",
        model: "gpt-4.1-mini",
        catalog: [{ provider: "openai", id: "gpt-4.1-mini", reasoning: false }],
      }),
    ).toBe("off");
  });
});

describe("resolveThinkingCapabilities", () => {
  it("keeps provider-name normalization as an outer-edge convenience", () => {
    expect(resolveThinkingCapabilities({ provider: "z.ai" })).toEqual({ binaryThinking: true });
    expect(resolveThinkingCapabilities({ provider: "z-ai" })).toEqual({ binaryThinking: true });
  });

  it("omits undefined capability fields", () => {
    expect(resolveThinkingCapabilities({ nativeAdaptive: true })).toEqual({ nativeAdaptive: true });
    expect(resolveThinkingCapabilities({ reasoningSupported: false })).toEqual({
      reasoningSupported: false,
    });
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

describe("resolveEffectiveThinking", () => {
  it("short-circuits off even when capabilities would otherwise conflict", () => {
    expect(
      resolveEffectiveThinking({
        requested: "off",
        capabilities: {
          reasoningSupported: false,
          binaryThinking: true,
          nativeAdaptive: true,
        },
      }),
    ).toEqual({
      requested: "off",
      effective: "off",
      status: "exact",
    });
  });

  it("preserves adaptive as requested intent for native adaptive providers", () => {
    expect(
      resolveEffectiveThinking({
        requested: "adaptive",
        capabilities: {
          nativeAdaptive: true,
          reasoningSupported: true,
        },
      }),
    ).toEqual({
      requested: "adaptive",
      effective: "adaptive",
      status: "exact",
    });
  });

  it("downgrades adaptive best-effort for graded providers without native adaptive", () => {
    expect(
      resolveEffectiveThinking({
        requested: "adaptive",
        capabilities: {
          reasoningSupported: true,
        },
      }),
    ).toEqual({
      requested: "adaptive",
      effective: "medium",
      status: "downgraded",
      reason: "adaptive_best_effort",
    });
  });

  it("maps adaptive to on for binary thinking providers", () => {
    expect(
      resolveEffectiveThinking({
        requested: "adaptive",
        capabilities: {
          reasoningSupported: true,
          binaryThinking: true,
        },
      }),
    ).toEqual({
      requested: "adaptive",
      effective: "on",
      status: "downgraded",
      reason: "binary_enabled",
    });
  });

  it.each(["minimal", "low", "high"] as const)(
    "maps %s to on for binary thinking providers",
    (requested) => {
      expect(
        resolveEffectiveThinking({
          requested,
          capabilities: {
            reasoningSupported: true,
            binaryThinking: true,
          },
        }),
      ).toEqual({
        requested,
        effective: "on",
        status: "downgraded",
        reason: "binary_enabled",
      });
    },
  );

  it("reports unsupported reasoning clearly", () => {
    expect(
      resolveEffectiveThinking({
        requested: "low",
        capabilities: {
          reasoningSupported: false,
        },
      }),
    ).toEqual({
      requested: "low",
      status: "unsupported",
      reason: "reasoning_unsupported",
    });
  });

  it("does not infer binary behavior when capabilities are omitted", () => {
    expect(
      resolveEffectiveThinking({
        requested: "adaptive",
      }),
    ).toEqual({
      requested: "adaptive",
      effective: "medium",
      status: "downgraded",
      reason: "adaptive_best_effort",
    });
  });

  it("passes through graded levels when capability inputs are omitted", () => {
    expect(
      resolveEffectiveThinking({
        requested: "low",
      }),
    ).toEqual({
      requested: "low",
      effective: "low",
      status: "exact",
    });
  });
});

describe("formatEffectiveThinkingResolution", () => {
  it("returns undefined for exact resolutions", () => {
    expect(
      formatEffectiveThinkingResolution({
        requested: "low",
        effective: "low",
        status: "exact",
      }),
    ).toBeUndefined();
  });

  it("formats unsupported reasoning clearly", () => {
    expect(
      formatEffectiveThinkingResolution({
        requested: "low",
        status: "unsupported",
        reason: "reasoning_unsupported",
      }),
    ).toBe("Reasoning is not supported for this model.");
  });

  it("formats adaptive best-effort downgrade clearly", () => {
    expect(
      formatEffectiveThinkingResolution({
        requested: "adaptive",
        effective: "medium",
        status: "downgraded",
        reason: "adaptive_best_effort",
      }),
    ).toBe("Adaptive thinking is not supported natively; using medium instead.");
  });

  it("formats binary downgrade clearly", () => {
    expect(
      formatEffectiveThinkingResolution({
        requested: "high",
        effective: "on",
        status: "downgraded",
        reason: "binary_enabled",
      }),
    ).toBe("Binary thinking only supports off/on; using on instead.");
  });
});
