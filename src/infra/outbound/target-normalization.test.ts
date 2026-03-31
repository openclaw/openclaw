import { beforeEach, describe, expect, it, vi } from "vitest";

const normalizeChannelIdMock = vi.hoisted(() => vi.fn());
const getChannelPluginMock = vi.hoisted(() => vi.fn());
const getActivePluginChannelRegistryVersionMock = vi.hoisted(() => vi.fn());

type TargetNormalizationModule = typeof import("./target-normalization.js");

let buildTargetResolverSignature: TargetNormalizationModule["buildTargetResolverSignature"];
let normalizeChannelTargetInput: TargetNormalizationModule["normalizeChannelTargetInput"];
let normalizeTargetForProvider: TargetNormalizationModule["normalizeTargetForProvider"];

async function loadTargetNormalizationModule() {
  vi.doMock("../../channels/plugins/index.js", () => ({
    normalizeChannelId: (...args: unknown[]) => normalizeChannelIdMock(...args),
    getChannelPlugin: (...args: unknown[]) => getChannelPluginMock(...args),
  }));
  vi.doMock("../../plugins/runtime.js", () => ({
    getActivePluginChannelRegistryVersion: (...args: unknown[]) =>
      getActivePluginChannelRegistryVersionMock(...args),
  }));
  ({ buildTargetResolverSignature, normalizeChannelTargetInput, normalizeTargetForProvider } =
    await import("./target-normalization.js"));
}

beforeEach(async () => {
  vi.resetModules();
  normalizeChannelIdMock.mockReset();
  getChannelPluginMock.mockReset();
  getActivePluginChannelRegistryVersionMock.mockReset();
  await loadTargetNormalizationModule();
});

describe("normalizeChannelTargetInput", () => {
  it("trims raw target input", () => {
    expect(normalizeChannelTargetInput("  channel:C1  ")).toBe("channel:C1");
  });
});

describe("normalizeTargetForProvider", () => {
  it.each([undefined, "   "])("returns undefined for blank raw input %j", (raw) => {
    expect(normalizeTargetForProvider("telegram", raw)).toBeUndefined();
  });

  it.each([
    {
      provider: "unknown",
      setup: () => {
        normalizeChannelIdMock.mockReturnValueOnce(null);
      },
      expected: "raw-id",
    },
    {
      provider: "telegram",
      setup: () => {
        normalizeChannelIdMock.mockReturnValueOnce("telegram");
        getActivePluginChannelRegistryVersionMock.mockReturnValueOnce(1);
        getChannelPluginMock.mockReturnValueOnce(undefined);
      },
      expected: "raw-id",
    },
  ])(
    "falls back to trimmed input when provider normalization misses for %j",
    ({ provider, setup, expected }) => {
      setup();
      expect(normalizeTargetForProvider(provider, "  raw-id  ")).toBe(expected);
    },
  );

  it("uses the cached target normalizer until the plugin registry version changes", () => {
    const firstNormalizer = vi.fn((raw: string) => raw.trim().toUpperCase());
    const secondNormalizer = vi.fn((raw: string) => `next:${raw.trim()}`);
    normalizeChannelIdMock.mockReturnValue("telegram");
    getActivePluginChannelRegistryVersionMock
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
    getActivePluginChannelRegistryVersionMock.mockReturnValueOnce(20);
    getChannelPluginMock.mockReturnValueOnce({
      messaging: {
        normalizeTarget: () => "",
      },
    });

    expect(normalizeTargetForProvider("telegram", "  raw-id  ")).toBeUndefined();
  });
});

describe("buildTargetResolverSignature", () => {
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
