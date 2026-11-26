// Setup promotion helper tests cover setup-result promotion into configured channel state.
import { beforeEach, describe, expect, it, vi } from "vitest";

const getLoadedChannelPluginMock = vi.hoisted(() => vi.fn());
const resolveBundledSurfaceMock = vi.hoisted(() => vi.fn());

vi.mock("./registry-loaded.js", () => ({
  getLoadedChannelPluginForRead: getLoadedChannelPluginMock,
}));

import { resolveSingleAccountPromotion } from "./setup-promotion-helpers.js";

function resolveSingleAccountKeysToMove(
  params: Parameters<typeof resolveSingleAccountPromotion>[0],
): string[] {
  const promotion = resolveSingleAccountPromotion(params);
  expect(promotion.kind).toBe("promote");
  if (promotion.kind !== "promote") {
    throw new Error("Expected ordinary account promotion");
  }
  return promotion.keysToMove;
}

const legacyCommonKeys = [
  "accessToken",
  "appToken",
  "httpUrl",
  "password",
  "userId",
  "webhookSecret",
] as const;
const legacySetupOnlyKeys = ["rooms"] as const;

function valuesFor(keys: readonly string[]): Record<string, string> {
  return Object.fromEntries(keys.map((key) => [key, `value:${key}`]));
}

describe("setup promotion helpers", () => {
  beforeEach(() => {
    getLoadedChannelPluginMock.mockReset();
    resolveBundledSurfaceMock.mockReset();
  });

  it("retains the published-reader common tier when no declarations resolve", () => {
    expect(
      resolveSingleAccountKeysToMove({
        channelKey: "demo",
        channel: {
          ...valuesFor(legacyCommonKeys),
          ...valuesFor(legacySetupOnlyKeys),
        },
      }),
    ).toEqual(legacyCommonKeys);
  });

  it("uses an injected bundled surface for non-static migration keys", () => {
    resolveBundledSurfaceMock.mockReturnValue({ singleAccountKeysToMove: ["customAuth"] });

    expect(
      resolveSingleAccountKeysToMove({
        channelKey: "demo",
        channel: {
          customAuth: "secret",
        },
        resolveBundledSurface: resolveBundledSurfaceMock,
      }),
    ).toEqual(["customAuth"]);
    expect(resolveBundledSurfaceMock).toHaveBeenCalledWith("demo");
  });

  it("honors loaded plugin named-account filters without bundled fallback", () => {
    getLoadedChannelPluginMock.mockReturnValue({
      setup: {
        namedAccountPromotionKeys: ["token"],
      },
    });

    const keys = resolveSingleAccountKeysToMove({
      channelKey: "demo",
      channel: {
        accounts: {
          work: { enabled: true },
        },
        token: "secret",
        dmPolicy: "allowlist",
      },
    });

    expect(keys).toEqual(["token"]);
    expect(resolveBundledSurfaceMock).not.toHaveBeenCalled();
  });
});
