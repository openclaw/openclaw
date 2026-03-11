import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { msteamsPlugin } from "../../extensions/msteams/src/channel.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { createTestRegistry } from "../test-utils/channel-plugins.js";
import { setDefaultChannelPluginRegistryForTests } from "./channel-test-helpers.js";
import { configMocks, offsetMocks } from "./channels.mock-harness.js";
import { baseConfigSnapshot, createTestRuntime } from "./test-runtime-config-helpers.js";

const runtime = createTestRuntime();
let channelsAddCommand: typeof import("./channels.js").channelsAddCommand;

describe("channelsAddCommand", () => {
  beforeAll(async () => {
    ({ channelsAddCommand } = await import("./channels.js"));
  });

  beforeEach(async () => {
    configMocks.readConfigFileSnapshot.mockClear();
    configMocks.writeConfigFile.mockClear();
    offsetMocks.deleteTelegramUpdateOffset.mockClear();
    runtime.log.mockClear();
    runtime.error.mockClear();
    runtime.exit.mockClear();
    setDefaultChannelPluginRegistryForTests();
  });

  it("clears telegram update offsets when the token changes", async () => {
    configMocks.readConfigFileSnapshot.mockResolvedValue({
      ...baseConfigSnapshot,
      config: {
        channels: {
          telegram: { botToken: "old-token", enabled: true },
        },
      },
    });

    await channelsAddCommand(
      { channel: "telegram", account: "default", token: "new-token" },
      runtime,
      { hasFlags: true },
    );

    expect(offsetMocks.deleteTelegramUpdateOffset).toHaveBeenCalledTimes(1);
    expect(offsetMocks.deleteTelegramUpdateOffset).toHaveBeenCalledWith({ accountId: "default" });
  });

  it("does not clear telegram update offsets when the token is unchanged", async () => {
    configMocks.readConfigFileSnapshot.mockResolvedValue({
      ...baseConfigSnapshot,
      config: {
        channels: {
          telegram: { botToken: "same-token", enabled: true },
        },
      },
    });

    await channelsAddCommand(
      { channel: "telegram", account: "default", token: "same-token" },
      runtime,
      { hasFlags: true },
    );

    expect(offsetMocks.deleteTelegramUpdateOffset).not.toHaveBeenCalled();
  });

  it("stores a per-account soul file when --soul is provided", async () => {
    configMocks.readConfigFileSnapshot.mockResolvedValue({
      ...baseConfigSnapshot,
      config: {},
    });

    await channelsAddCommand(
      {
        channel: "slack",
        account: "work",
        botToken: "xoxb-1",
        appToken: "xapp-1",
        soul: "SOUL.work.md",
      },
      runtime,
      { hasFlags: true },
    );

    expect(configMocks.writeConfigFile).toHaveBeenCalledTimes(1);
    expect(configMocks.writeConfigFile.mock.calls[0]?.[0]).toMatchObject({
      channels: {
        slack: {
          accounts: {
            work: {
              botToken: "xoxb-1",
              appToken: "xapp-1",
              soulFile: "SOUL.work.md",
            },
          },
        },
      },
    });
  });

  it("rejects --soul for channels without account-scoped soulFile support", async () => {
    setActivePluginRegistry(
      createTestRegistry([{ pluginId: "msteams", plugin: msteamsPlugin, source: "test" }]),
    );
    configMocks.readConfigFileSnapshot.mockResolvedValue({
      ...baseConfigSnapshot,
      config: {},
    });

    await channelsAddCommand(
      {
        channel: "msteams",
        soul: "SOUL.msteams.md",
      },
      runtime,
      { hasFlags: true },
    );

    expect(runtime.error).toHaveBeenCalledWith(
      "Channel msteams does not support account-scoped SOUL files via --soul in its current config shape.",
    );
    expect(runtime.exit).toHaveBeenCalledWith(1);
    expect(configMocks.writeConfigFile).not.toHaveBeenCalled();
  });
});
