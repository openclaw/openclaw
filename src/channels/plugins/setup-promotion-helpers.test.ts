// Setup promotion helper tests cover setup-result promotion into configured channel state.
import { beforeEach, describe, expect, it, vi } from "vitest";

const getBundledChannelPluginMock = vi.hoisted(() => vi.fn());
const hasBundledChannelPackageSetupFeatureMock = vi.hoisted(() => vi.fn());
const getLoadedChannelPluginMock = vi.hoisted(() => vi.fn());

vi.mock("./bundled.js", () => ({
  getBundledChannelPlugin: getBundledChannelPluginMock,
  hasBundledChannelPackageSetupFeature: hasBundledChannelPackageSetupFeatureMock,
}));

vi.mock("./registry.js", () => ({
  getLoadedChannelPlugin: getLoadedChannelPluginMock,
}));

import { resolveSingleAccountKeysToMove } from "./setup-promotion-helpers.js";

describe("setup promotion helpers", () => {
  beforeEach(() => {
    getBundledChannelPluginMock.mockReset();
    hasBundledChannelPackageSetupFeatureMock.mockReset();
    hasBundledChannelPackageSetupFeatureMock.mockReturnValue(false);
    getLoadedChannelPluginMock.mockReset();
  });

  it("keeps static single-account migration keys cheap", () => {
    const keys = resolveSingleAccountKeysToMove({
      channelKey: "demo",
      channel: {
        defaultAccount: "ops",
        dmPolicy: "allowlist",
        allowFrom: ["+15551234567"],
        groupPolicy: "allowlist",
        groupAllowFrom: ["group-123"],
      },
    });

    expect(keys).toEqual(["dmPolicy", "allowFrom", "groupPolicy", "groupAllowFrom"]);
    expect(getLoadedChannelPluginMock).not.toHaveBeenCalled();
    expect(getBundledChannelPluginMock).not.toHaveBeenCalled();
  });

  it("keeps channel-owned keys out of the common promotion tier", () => {
    const keys = resolveSingleAccountKeysToMove({
      channelKey: "demo",
      channel: {
        tokenFile: "/tmp/token",
        botId: "legacy-wecom-bot",
        secret: "legacy-wecom-secret",
        appToken: "channel-owned",
        cliPath: "/opt/channel-cli",
        accessToken: "channel-owned",
      },
    });

    expect(keys).toEqual(["tokenFile", "botId", "secret"]);
  });

  it("prefers a caller-supplied setup surface over registry and bundled lookup", () => {
    getLoadedChannelPluginMock.mockReturnValue({
      setup: { singleAccountKeysToMove: ["loadedKey"] },
    });
    hasBundledChannelPackageSetupFeatureMock.mockReturnValue(true);
    getBundledChannelPluginMock.mockReturnValue({
      setup: { singleAccountKeysToMove: ["bundledKey"] },
    });

    const keys = resolveSingleAccountKeysToMove({
      channelKey: "scoped",
      channel: {
        callerKey: true,
        loadedKey: true,
        bundledKey: true,
      },
      setupSurface: { singleAccountKeysToMove: ["callerKey"] },
    });

    expect(keys).toEqual(["callerKey"]);
    expect(getLoadedChannelPluginMock).not.toHaveBeenCalled();
    expect(getBundledChannelPluginMock).not.toHaveBeenCalled();
  });

  it("unions the setup generic tier with plugin-declared keys", () => {
    const keys = resolveSingleAccountKeysToMove({
      channelKey: "demo",
      channel: {
        streaming: { mode: "partial" },
        appToken: "xapp-test",
        unrelated: true,
      },
      setupSurface: { singleAccountKeysToMove: ["appToken"] },
      includeSetupKeys: true,
    });

    expect(keys).toEqual(["streaming", "appToken"]);
  });

  it("skips bundled setup promotion without a manifest feature", () => {
    const keys = resolveSingleAccountKeysToMove({
      channelKey: "demo",
      channel: {
        accounts: {
          work: { enabled: true },
        },
        dmPolicy: "allowlist",
        allowFrom: ["+15551234567"],
        groupPolicy: "allowlist",
        groupAllowFrom: ["group-123"],
      },
    });

    expect(keys).toEqual(["dmPolicy", "allowFrom", "groupPolicy", "groupAllowFrom"]);
    expect(getLoadedChannelPluginMock).toHaveBeenCalledWith("demo");
    expect(hasBundledChannelPackageSetupFeatureMock).toHaveBeenCalledWith(
      "demo",
      "configPromotion",
    );
    expect(getBundledChannelPluginMock).not.toHaveBeenCalled();
  });

  it("loads bundled setup only for non-static migration keys", () => {
    hasBundledChannelPackageSetupFeatureMock.mockReturnValue(true);
    getBundledChannelPluginMock.mockReturnValue({
      setup: {
        singleAccountKeysToMove: ["customAuth"],
      },
    });

    expect(
      resolveSingleAccountKeysToMove({
        channelKey: "demo",
        channel: {
          customAuth: "secret",
        },
      }),
    ).toEqual(["customAuth"]);
    expect(getBundledChannelPluginMock).toHaveBeenCalledWith("demo");
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
    expect(getBundledChannelPluginMock).not.toHaveBeenCalled();
  });

  it("loads bundled setup for named-account filters before registry bootstrap", () => {
    hasBundledChannelPackageSetupFeatureMock.mockReturnValue(true);
    getBundledChannelPluginMock.mockReturnValue({
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
    expect(getLoadedChannelPluginMock).toHaveBeenCalledWith("demo");
    expect(getBundledChannelPluginMock).toHaveBeenCalledWith("demo");
  });
});
