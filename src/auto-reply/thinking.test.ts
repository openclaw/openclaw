import { beforeEach, describe, expect, it, vi } from "vitest";

const providerRuntimeMocks = vi.hoisted(() => ({
  resolveProviderBinaryThinking: vi.fn(),
  resolveProviderDefaultThinkingLevel: vi.fn(),
  resolveProviderXHighThinking: vi.fn(),
}));

vi.mock("../plugins/provider-runtime.js", () => ({
  resolveProviderBinaryThinking: providerRuntimeMocks.resolveProviderBinaryThinking,
  resolveProviderDefaultThinkingLevel: providerRuntimeMocks.resolveProviderDefaultThinkingLevel,
  resolveProviderXHighThinking: providerRuntimeMocks.resolveProviderXHighThinking,
}));
import {
  listThinkingLevelLabels,
  listThinkingLevels,
  normalizeReasoningLevel,
  normalizeThinkLevel,
  resolveThinkingDefaultForModel,
} from "./thinking.js";

beforeEach(() => {
  providerRuntimeMocks.resolveProviderBinaryThinking.mockReset();
  providerRuntimeMocks.resolveProviderBinaryThinking.mockReturnValue(undefined);
  providerRuntimeMocks.resolveProviderDefaultThinkingLevel.mockReset();
  providerRuntimeMocks.resolveProviderDefaultThinkingLevel.mockReturnValue(undefined);
  providerRuntimeMocks.resolveProviderXHighThinking.mockReset();
  providerRuntimeMocks.resolveProviderXHighThinking.mockReturnValue(undefined);
});

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
  it("uses provider runtime hooks for xhigh support", () => {
    providerRuntimeMocks.resolveProviderXHighThinking.mockReturnValue(true);

    expect(listThinkingLevels("demo", "demo-model")).toContain("xhigh");
  });

  it("includes xhigh for provider-advertised models", () => {
    providerRuntimeMocks.resolveProviderXHighThinking.mockImplementation(({ provider, context }) =>
      (provider === "openai" && ["gpt-5.2", "gpt-5.4", "gpt-5.4-pro"].includes(context.modelId)) ||
      (provider === "openai-codex" &&
        ["gpt-5.2-codex", "gpt-5.3-codex", "gpt-5.3-codex-spark", "gpt-5.4"].includes(
          context.modelId,
        )) ||
      (provider === "github-copilot" && ["gpt-5.2", "gpt-5.2-codex"].includes(context.modelId))
        ? true
        : undefined,
    );

    expect(listThinkingLevels("openai-codex", "gpt-5.2-codex")).toContain("xhigh");
    expect(listThinkingLevels("openai-codex", "gpt-5.3-codex")).toContain("xhigh");
    expect(listThinkingLevels("openai-codex", "gpt-5.3-codex-spark")).toContain("xhigh");
    expect(listThinkingLevels("openai", "gpt-5.2")).toContain("xhigh");
    expect(listThinkingLevels("openai", "gpt-5.4")).toContain("xhigh");
    expect(listThinkingLevels("openai", "gpt-5.4-pro")).toContain("xhigh");
    expect(listThinkingLevels("openai-codex", "gpt-5.4")).toContain("xhigh");
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
  it("uses provider runtime hooks for binary thinking providers", () => {
    providerRuntimeMocks.resolveProviderBinaryThinking.mockReturnValue(true);

    expect(listThinkingLevelLabels("demo", "demo-model")).toEqual(["off", "on"]);
  });

  it("returns on/off for provider-advertised binary thinking", () => {
    providerRuntimeMocks.resolveProviderBinaryThinking.mockImplementation(({ provider }) =>
      provider === "zai" ? true : undefined,
    );

    expect(listThinkingLevelLabels("zai", "glm-4.7")).toEqual(["off", "on"]);
  });

  it("returns full levels for non-ZAI", () => {
    expect(listThinkingLevelLabels("openai", "gpt-4.1-mini")).toContain("low");
    expect(listThinkingLevelLabels("openai", "gpt-4.1-mini")).not.toContain("on");
  });
});

describe("resolveThinkingDefaultForModel", () => {
  it("uses provider runtime hooks for default thinking levels", () => {
    providerRuntimeMocks.resolveProviderDefaultThinkingLevel.mockReturnValue("adaptive");

    expect(resolveThinkingDefaultForModel({ provider: "demo", model: "demo-model" })).toBe(
      "adaptive",
    );
  });

  it("uses provider-advertised adaptive defaults", () => {
    providerRuntimeMocks.resolveProviderDefaultThinkingLevel.mockImplementation(
      ({ provider, context }) =>
        provider === "anthropic" && context.modelId === "claude-opus-4-6" ? "adaptive" : undefined,
    );

    expect(
      resolveThinkingDefaultForModel({ provider: "anthropic", model: "claude-opus-4-6" }),
    ).toBe("adaptive");
  });

  it("uses provider-advertised adaptive defaults for Bedrock aliases", () => {
    providerRuntimeMocks.resolveProviderDefaultThinkingLevel.mockImplementation(
      ({ provider, context }) =>
        provider === "amazon-bedrock" && context.modelId === "claude-sonnet-4-6"
          ? "adaptive"
          : undefined,
    );

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
