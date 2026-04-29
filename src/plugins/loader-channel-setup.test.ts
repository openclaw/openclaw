import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";

vi.mock("../config/channel-configured.js", () => ({
  isChannelConfigured: vi.fn().mockReturnValue(false),
}));

const { isChannelConfigured } = await import("../config/channel-configured.js");
const isChannelConfiguredMock = vi.mocked(isChannelConfigured);

const { channelPluginIdBelongsToManifest, shouldLoadChannelPluginInSetupRuntime } =
  await import("./loader-channel-setup.js");

const emptyEnv: NodeJS.ProcessEnv = Object.create(null);
const emptyCfg = {} as OpenClawConfig;

beforeEach(() => {
  isChannelConfiguredMock.mockReset();
  isChannelConfiguredMock.mockReturnValue(false);
});

describe("shouldLoadChannelPluginInSetupRuntime", () => {
  it("returns false when setupSource is missing", () => {
    expect(
      shouldLoadChannelPluginInSetupRuntime({
        manifestChannels: ["slack"],
        cfg: emptyCfg,
        env: emptyEnv,
      }),
    ).toBe(false);
    expect(isChannelConfiguredMock).not.toHaveBeenCalled();
  });

  it("returns false when manifestChannels is empty", () => {
    expect(
      shouldLoadChannelPluginInSetupRuntime({
        manifestChannels: [],
        setupSource: "bundled",
        cfg: emptyCfg,
        env: emptyEnv,
      }),
    ).toBe(false);
    expect(isChannelConfiguredMock).not.toHaveBeenCalled();
  });

  it("short-circuits to true when prefer-setup and full-load-defer are both on", () => {
    expect(
      shouldLoadChannelPluginInSetupRuntime({
        manifestChannels: ["slack"],
        setupSource: "bundled",
        preferSetupRuntimeForChannelPlugins: true,
        startupDeferConfiguredChannelFullLoadUntilAfterListen: true,
        cfg: emptyCfg,
        env: emptyEnv,
      }),
    ).toBe(true);
    expect(isChannelConfiguredMock).not.toHaveBeenCalled();
  });

  it("does not short-circuit when prefer-setup is on but full-load-defer is off", () => {
    expect(
      shouldLoadChannelPluginInSetupRuntime({
        manifestChannels: ["slack"],
        setupSource: "bundled",
        preferSetupRuntimeForChannelPlugins: true,
        startupDeferConfiguredChannelFullLoadUntilAfterListen: false,
        cfg: emptyCfg,
        env: emptyEnv,
      }),
    ).toBe(true);
    expect(isChannelConfiguredMock).toHaveBeenCalledWith(emptyCfg, "slack", emptyEnv);
  });

  it("returns true when no manifest channel is configured (cold setup)", () => {
    expect(
      shouldLoadChannelPluginInSetupRuntime({
        manifestChannels: ["slack", "discord"],
        setupSource: "bundled",
        cfg: emptyCfg,
        env: emptyEnv,
      }),
    ).toBe(true);
    expect(isChannelConfiguredMock).toHaveBeenCalledTimes(2);
  });

  it("returns false when at least one manifest channel is configured", () => {
    isChannelConfiguredMock.mockImplementation((_cfg, channelId) => channelId === "slack");
    expect(
      shouldLoadChannelPluginInSetupRuntime({
        manifestChannels: ["slack", "discord"],
        setupSource: "bundled",
        cfg: emptyCfg,
        env: emptyEnv,
      }),
    ).toBe(false);
  });
});

describe("channelPluginIdBelongsToManifest", () => {
  it("returns true when channelId is undefined (no scoping)", () => {
    expect(
      channelPluginIdBelongsToManifest({
        channelId: undefined,
        pluginId: "slack",
        manifestChannels: ["slack", "discord"],
      }),
    ).toBe(true);
  });

  it("returns true when channelId matches the plugin id directly", () => {
    expect(
      channelPluginIdBelongsToManifest({
        channelId: "slack",
        pluginId: "slack",
        manifestChannels: [],
      }),
    ).toBe(true);
  });

  it("returns true when the manifest contains the channelId", () => {
    expect(
      channelPluginIdBelongsToManifest({
        channelId: "extra",
        pluginId: "slack",
        manifestChannels: ["slack", "extra"],
      }),
    ).toBe(true);
  });

  it("returns false when channelId matches neither the plugin id nor the manifest", () => {
    expect(
      channelPluginIdBelongsToManifest({
        channelId: "telegram",
        pluginId: "slack",
        manifestChannels: ["slack", "discord"],
      }),
    ).toBe(false);
  });
});
