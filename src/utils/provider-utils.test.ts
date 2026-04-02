import { beforeEach, describe, expect, it, vi } from "vitest";

const { resolveProviderReasoningOutputModeWithPluginMock } = vi.hoisted(() => ({
  resolveProviderReasoningOutputModeWithPluginMock: vi.fn(),
}));

vi.mock("../plugins/provider-runtime.js", () => ({
  resolveProviderReasoningOutputModeWithPlugin: resolveProviderReasoningOutputModeWithPluginMock,
}));

import { isReasoningTagProvider, resolveReasoningOutputMode } from "./provider-utils.js";

describe("resolveReasoningOutputMode", () => {
  beforeEach(() => {
    resolveProviderReasoningOutputModeWithPluginMock.mockReset();
    resolveProviderReasoningOutputModeWithPluginMock.mockReturnValue(undefined);
  });

  it.each([
    ["google", "tagged"],
    ["Google", "tagged"],
    ["google-gemini-cli", "tagged"],
    ["google-generative-ai", "tagged"],
    ["anthropic", "native"],
    ["openai", "native"],
    ["openrouter", "native"],
    ["ollama", "native"],
    ["minimax", "native"],
    ["minimax-cn", "native"],
  ] as const)("uses the built-in fast path for %s", (provider, expected) => {
    expect(resolveReasoningOutputMode({ provider, workspaceDir: process.cwd() })).toBe(expected);
    expect(resolveProviderReasoningOutputModeWithPluginMock).not.toHaveBeenCalled();
  });

  it("falls back to provider hooks for unknown providers", () => {
    resolveProviderReasoningOutputModeWithPluginMock.mockReturnValue("tagged");

    expect(
      resolveReasoningOutputMode({
        provider: "custom-provider",
        workspaceDir: process.cwd(),
        modelId: "custom/model",
      }),
    ).toBe("tagged");
    expect(resolveProviderReasoningOutputModeWithPluginMock).toHaveBeenCalledTimes(1);
  });

  it("returns native when hooks do not provide an override", () => {
    expect(resolveReasoningOutputMode({ provider: "custom-provider" })).toBe("native");
    expect(resolveProviderReasoningOutputModeWithPluginMock).toHaveBeenCalledTimes(1);
  });
});

describe("isReasoningTagProvider", () => {
  beforeEach(() => {
    resolveProviderReasoningOutputModeWithPluginMock.mockReset();
    resolveProviderReasoningOutputModeWithPluginMock.mockReturnValue(undefined);
  });

  it.each([
    ["google", true],
    ["Google", true],
    ["google-gemini-cli", true],
    ["google-generative-ai", true],
    ["anthropic", false],
    ["openai", false],
    ["openrouter", false],
    ["ollama", false],
    ["minimax", false],
    ["minimax-cn", false],
    [null, false],
    [undefined, false],
    ["", false],
  ] as const)("returns %s for %s", (value, expected) => {
    expect(isReasoningTagProvider(value, { workspaceDir: process.cwd() })).toBe(expected);
  });
});
