import { afterEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";
import {
  channelSupportsMessageCapability,
  channelSupportsMessageCapabilityForChannel,
  listChannelMessageCapabilities,
  listChannelMessageCapabilitiesForChannel,
} from "./message-actions.js";
import type { ChannelMessageCapability } from "./message-capabilities.js";
import type { ChannelPlugin } from "./types.js";

const emptyRegistry = createTestRegistry([]);

function createMessageActionsPlugin(params: {
  id: "discord" | "telegram";
  capabilities: readonly ChannelMessageCapability[];
}): ChannelPlugin {
  return {
    ...createChannelTestPluginBase({
      id: params.id,
      label: params.id === "discord" ? "Discord" : "Telegram",
      capabilities: { chatTypes: ["direct", "group"] },
      config: {
        listAccountIds: () => ["default"],
      },
    }),
    actions: {
      listActions: () => ["send"],
      getCapabilities: () => params.capabilities,
    },
  };
}

const buttonsPlugin = createMessageActionsPlugin({
  id: "discord",
  capabilities: ["interactive", "buttons"],
});

const cardsPlugin = createMessageActionsPlugin({
  id: "telegram",
  capabilities: ["cards"],
});

function activateMessageActionTestRegistry() {
  setActivePluginRegistry(
    createTestRegistry([
      { pluginId: "discord", source: "test", plugin: buttonsPlugin },
      { pluginId: "telegram", source: "test", plugin: cardsPlugin },
    ]),
  );
}

describe("message action capability checks", () => {
  afterEach(() => {
    setActivePluginRegistry(emptyRegistry);
  });

  it("aggregates capabilities across plugins", () => {
    activateMessageActionTestRegistry();

    expect(listChannelMessageCapabilities({} as OpenClawConfig).toSorted()).toEqual([
      "buttons",
      "cards",
      "interactive",
    ]);
    expect(channelSupportsMessageCapability({} as OpenClawConfig, "interactive")).toBe(true);
    expect(channelSupportsMessageCapability({} as OpenClawConfig, "buttons")).toBe(true);
    expect(channelSupportsMessageCapability({} as OpenClawConfig, "cards")).toBe(true);
  });

  it("checks per-channel capabilities", () => {
    activateMessageActionTestRegistry();

    expect(
      listChannelMessageCapabilitiesForChannel({
        cfg: {} as OpenClawConfig,
        channel: "discord",
      }),
    ).toEqual(["interactive", "buttons"]);
    expect(
      listChannelMessageCapabilitiesForChannel({
        cfg: {} as OpenClawConfig,
        channel: "telegram",
      }),
    ).toEqual(["cards"]);
    expect(
      channelSupportsMessageCapabilityForChannel(
        { cfg: {} as OpenClawConfig, channel: "discord" },
        "interactive",
      ),
    ).toBe(true);
    expect(
      channelSupportsMessageCapabilityForChannel(
        { cfg: {} as OpenClawConfig, channel: "telegram" },
        "interactive",
      ),
    ).toBe(false);
    expect(
      channelSupportsMessageCapabilityForChannel(
        { cfg: {} as OpenClawConfig, channel: "discord" },
        "buttons",
      ),
    ).toBe(true);
    expect(
      channelSupportsMessageCapabilityForChannel(
        { cfg: {} as OpenClawConfig, channel: "telegram" },
        "buttons",
      ),
    ).toBe(false);
    expect(
      channelSupportsMessageCapabilityForChannel(
        { cfg: {} as OpenClawConfig, channel: "telegram" },
        "cards",
      ),
    ).toBe(true);
    expect(channelSupportsMessageCapabilityForChannel({ cfg: {} as OpenClawConfig }, "cards")).toBe(
      false,
    );
  });
});
