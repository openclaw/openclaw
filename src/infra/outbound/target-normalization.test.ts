// Covers target input normalization and plugin resolver defaults.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import {
  looksLikeTargetId,
  maybeResolvePluginMessagingTarget,
  normalizeTargetForProvider,
  resolveNormalizedTargetInput,
} from "./target-normalization.js";

const getLoadedChannelPluginMock = vi.hoisted(() => vi.fn());
const getChannelPluginMock = vi.hoisted(() => vi.fn());
const getActivePluginChannelRegistryVersionMock = vi.hoisted(() => vi.fn());

let registryVersion = 0;

vi.mock("../../channels/plugins/registry-loaded.js", () => ({
  getLoadedChannelPluginForRead: (...args: unknown[]) => getLoadedChannelPluginMock(...args),
}));

vi.mock("../../channels/plugins/index.js", () => ({
  getChannelPlugin: (...args: unknown[]) => getChannelPluginMock(...args),
}));

vi.mock("../../plugins/runtime.js", () => ({
  getActivePluginChannelRegistryVersion: (...args: unknown[]) =>
    getActivePluginChannelRegistryVersionMock(...args),
}));

beforeEach(() => {
  getLoadedChannelPluginMock.mockReset();
  getChannelPluginMock.mockReset();
  getActivePluginChannelRegistryVersionMock.mockReset();
  // Isolate fixtures through the owner's registry-generation cache contract.
  getActivePluginChannelRegistryVersionMock.mockReturnValue(++registryVersion);
});

describe("normalizeTargetForProvider", () => {
  it("returns undefined for missing raw input", () => {
    expect(normalizeTargetForProvider("alpha", undefined)).toBeUndefined();
  });
});

describe("resolveNormalizedTargetInput", () => {
  it("returns undefined for blank input", () => {
    expect(resolveNormalizedTargetInput("alpha", "   ")).toBeUndefined();
  });
});

describe("looksLikeTargetId", () => {
  it("falls back to the built-in thread heuristic", () => {
    getLoadedChannelPluginMock.mockReturnValueOnce(undefined);
    getChannelPluginMock.mockReturnValueOnce(undefined);
    expect(looksLikeTargetId({ channel: "workspace", raw: "foo@thread" })).toBe(true);
  });
});

describe("maybeResolvePluginMessagingTarget", () => {
  const cfg = {} as OpenClawConfig;

  it("invokes the plugin resolver with normalized input and defaults source", async () => {
    const resolveTarget = vi.fn().mockResolvedValue({
      to: "channel:C123ABC",
      kind: "group",
      display: "general",
    });
    getLoadedChannelPluginMock
      .mockReturnValueOnce({
        messaging: {
          normalizeTarget: (raw: string) => raw.trim().toUpperCase(),
        },
      })
      .mockReturnValueOnce({
        messaging: {
          targetResolver: {
            resolveTarget,
          },
        },
      });

    await expect(
      maybeResolvePluginMessagingTarget({
        cfg,
        channel: "workspace",
        input: "  channel:c123abc  ",
      }),
    ).resolves.toEqual({
      to: "channel:C123ABC",
      kind: "group",
      display: "general",
      source: "normalized",
      resolutionSource: "plugin",
    });

    expect(resolveTarget).toHaveBeenCalledWith({
      cfg,
      accountId: undefined,
      input: "channel:c123abc",
      normalized: "CHANNEL:C123ABC",
      preferredKind: undefined,
    });
  });
});
