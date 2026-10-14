import { beforeEach, describe, expect, it, vi } from "vitest";

const { resolveProviderReasoningOutputModeWithPluginMock } = vi.hoisted(() => ({
  resolveProviderReasoningOutputModeWithPluginMock: vi.fn(),
}));

vi.mock("../plugins/provider-runtime.js", () => ({
  resolveProviderReasoningOutputModeWithPlugin: resolveProviderReasoningOutputModeWithPluginMock,
}));

import { isReasoningTagProvider } from "./provider-utils.js";

describe("isReasoningTagProvider", () => {
  beforeEach(() => {
    resolveProviderReasoningOutputModeWithPluginMock.mockReset();
  });

  it.each([
    ["tagged", true, { workspaceDir: process.cwd(), modelId: "custom/model" }],
    ["native", false, undefined],
    [undefined, false, undefined],
  ] as const)("interprets provider hook mode %s", (mode, expected, options) => {
    resolveProviderReasoningOutputModeWithPluginMock.mockReturnValueOnce(mode);

    expect(isReasoningTagProvider("custom-provider", options)).toBe(expected);
    expect(resolveProviderReasoningOutputModeWithPluginMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["google-generative-ai", 1],
    [null, 0],
    [undefined, 0],
    ["", 0],
  ] as const)("defaults to native for %s", (provider, expectedCalls) => {
    expect(isReasoningTagProvider(provider, { workspaceDir: process.cwd() })).toBe(false);
    expect(resolveProviderReasoningOutputModeWithPluginMock).toHaveBeenCalledTimes(expectedCalls);
  });
});
