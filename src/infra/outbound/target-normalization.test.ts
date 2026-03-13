import { beforeEach, describe, expect, it, vi } from "vitest";

const normalizeChannelIdMock = vi.hoisted(() => vi.fn());
const getChannelPluginMock = vi.hoisted(() => vi.fn());
const getActivePluginRegistryVersionMock = vi.hoisted(() => vi.fn());

vi.mock("../../channels/plugins/index.js", () => ({
  normalizeChannelId: (...args: unknown[]) => normalizeChannelIdMock(...args),
  getChannelPlugin: (...args: unknown[]) => getChannelPluginMock(...args),
}));

vi.mock("../../plugins/runtime.js", () => ({
  getActivePluginRegistryVersion: (...args: unknown[]) =>
    getActivePluginRegistryVersionMock(...args),
}));

import {
  buildTargetResolverSignature,
  normalizeChannelTargetInput,
  normalizeTargetForProvider,
} from "./target-normalization.js";

describe("normalizeChannelTargetInput", () => {
  it("trims raw target input", () => {
    expect(normalizeChannelTargetInput("  channel:C1  ")).toBe("channel:C1");
  });
});

describe("normalizeTargetForProvider", () => {
  beforeEach(() => {
    normalizeChannelIdMock.mockReset();
    getChannelPluginMock.mockReset();
    getActivePluginRegistryVersionMock.mockReset();
  });

  it("returns undefined for missing or blank raw input", () => {
    expect(normalizeTargetForProvider("telegram")).toBeUndefined();
    expect(normalizeTargetForProvider("telegram", "   ")).toBeUndefined();
  });

  it("falls back to trimmed input when the provider is unknown or has no normalizer", () => {
    normalizeChannelIdMock.mockReturnValueOnce(null);
    expect(normalizeTargetForProvider("unknown", "  raw-id  ")).toBe("raw-id");

    normalizeChannelIdMock.mockReturnValueOnce("telegram");
    getActivePluginRegistryVersionMock.mockReturnValueOnce(1);
    getChannelPluginMock.mockReturnValueOnce(undefined);
    expect(normalizeTargetForProvider("telegram", "  raw-id  ")).toBe("raw-id");
  });

  it("uses the cached target normalizer until the plugin registry version changes", () => {
    const firstNormalizer = vi.fn((raw: string) => raw.trim().toUpperCase());
    const secondNormalizer = vi.fn((raw: string) => `next:${raw.trim()}`);
    normalizeChannelIdMock.mockReturnValue("telegram");
    getActivePluginRegistryVersionMock
      .mockReturnValueOnce(10)
      .mockReturnValueOnce(10)
      .mockReturnValueOnce(11);
    getChannelPluginMock
      .mockReturnValueOnce({
        messaging: { normalizeTarget: firstNormalizer },
      })
      .mockReturnValueOnce({
        messaging: { normalizeTarget: secondNormalizer },
      });

    expect(normalizeTargetForProvider("telegram", "  abc  ")).toBe("ABC");
    expect(normalizeTargetForProvider("telegram", "  def  ")).toBe("DEF");
    expect(normalizeTargetForProvider("telegram", "  ghi  ")).toBe("next:ghi");

    expect(getChannelPluginMock).toHaveBeenCalledTimes(2);
    expect(firstNormalizer).toHaveBeenCalledTimes(2);
    expect(secondNormalizer).toHaveBeenCalledTimes(1);
  });

  it("returns undefined when the provider normalizer resolves to an empty value", () => {
    normalizeChannelIdMock.mockReturnValueOnce("telegram");
    getActivePluginRegistryVersionMock.mockReturnValueOnce(20);
    getChannelPluginMock.mockReturnValueOnce({
      messaging: {
        normalizeTarget: () => "",
      },
    });

    expect(normalizeTargetForProvider("telegram", "  raw-id  ")).toBeUndefined();
  });
});

describe("buildTargetResolverSignature", () => {
  beforeEach(() => {
    getChannelPluginMock.mockReset();
  });

  it("builds stable signatures from resolver hint and looksLikeId source", () => {
    const looksLikeId = (value: string) => value.startsWith("C");
    getChannelPluginMock.mockReturnValueOnce({
      messaging: {
        targetResolver: {
          hint: "Use channel id",
          looksLikeId,
        },
      },
    });

    const first = buildTargetResolverSignature("slack");
    getChannelPluginMock.mockReturnValueOnce({
      messaging: {
        targetResolver: {
          hint: "Use channel id",
          looksLikeId,
        },
      },
    });
    const second = buildTargetResolverSignature("slack");

    expect(first).toBe(second);
  });

  it("changes when resolver metadata changes", () => {
    getChannelPluginMock.mockReturnValueOnce({
      messaging: {
        targetResolver: {
          hint: "Use channel id",
          looksLikeId: (value: string) => value.startsWith("C"),
        },
      },
    });
    const first = buildTargetResolverSignature("slack");

    getChannelPluginMock.mockReturnValueOnce({
      messaging: {
        targetResolver: {
          hint: "Use user id",
          looksLikeId: (value: string) => value.startsWith("U"),
        },
      },
    });
    const second = buildTargetResolverSignature("slack");

    expect(first).not.toBe(second);
  });
});
