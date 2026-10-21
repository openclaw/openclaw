import { beforeEach, expect, it, vi } from "vitest";
import {
  looksLikeTargetId,
  maybeResolvePluginMessagingTarget,
  normalizeTargetForProvider,
  resolveNormalizedTargetInput,
} from "./target-normalization.js";

const getLoadedChannelPluginMock = vi.hoisted(() => vi.fn());
const getChannelPluginMock = vi.hoisted(() => vi.fn());

vi.mock("../../channels/plugins/registry-loaded.js", () => ({
  getLoadedChannelPluginForRead: (...args: unknown[]) => getLoadedChannelPluginMock(...args),
}));

vi.mock("../../channels/plugins/index.js", () => ({
  getChannelPlugin: (...args: unknown[]) => getChannelPluginMock(...args),
}));

beforeEach(() => {
  getLoadedChannelPluginMock.mockReset();
  getChannelPluginMock.mockReset();
});

it("normalizeTargetForProvider returns undefined for missing raw input", () => {
  expect(normalizeTargetForProvider("alpha", undefined)).toBeUndefined();
});

it("resolveNormalizedTargetInput returns undefined for blank input", () => {
  expect(resolveNormalizedTargetInput("alpha", "   ")).toBeUndefined();
});

it("looksLikeTargetId falls back to the built-in thread heuristic", () => {
  expect(looksLikeTargetId({ channel: "workspace", raw: "foo@thread" })).toBe(true);
});

it("invokes the plugin resolver with normalized input and defaults source", async () => {
  const cfg = {};
  const resolved = { to: "channel:C123ABC", kind: "group", display: "general" };
  const resolveTarget = vi.fn().mockResolvedValue(resolved);
  getLoadedChannelPluginMock
    .mockReturnValueOnce({
      messaging: { normalizeTarget: (raw: string) => raw.trim().toUpperCase() },
    })
    .mockReturnValueOnce({
      messaging: { targetResolver: { resolveTarget } },
    });

  await expect(
    maybeResolvePluginMessagingTarget({ cfg, channel: "workspace", input: "  channel:c123abc  " }),
  ).resolves.toEqual({
    ...resolved,
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
