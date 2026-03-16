import { afterEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";
import {
  supportsChannelMessageButtons,
  supportsChannelMessageButtonsForChannel,
  supportsChannelMessageCards,
  supportsChannelMessageCardsForChannel,
  supportsChannelMessageInteractive,
  supportsChannelMessageInteractiveForChannel,
} from "./message-actions.js";
import type { ChannelPlugin } from "./types.js";

const emptyRegistry = createTestRegistry([]);

function createMessageActionsPlugin(params: {
  id: "discord" | "telegram";
  supportsInteractive: boolean;
  supportsButtons: boolean;
  supportsCards: boolean;
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
      supportsInteractive: () => params.supportsInteractive,
      supportsButtons: () => params.supportsButtons,
      supportsCards: () => params.supportsCards,
    },
  };
}

const buttonsPlugin = createMessageActionsPlugin({
  id: "discord",
  supportsInteractive: true,
  supportsButtons: true,
  supportsCards: false,
});

const cardsPlugin = createMessageActionsPlugin({
  id: "telegram",
  supportsInteractive: false,
  supportsButtons: false,
  supportsCards: true,
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

  it("aggregates buttons/card support across plugins", () => {
    activateMessageActionTestRegistry();

    expect(supportsChannelMessageInteractive({} as OpenClawConfig)).toBe(true);
    expect(supportsChannelMessageButtons({} as OpenClawConfig)).toBe(true);
    expect(supportsChannelMessageCards({} as OpenClawConfig)).toBe(true);
  });

  it("checks per-channel capabilities", () => {
    activateMessageActionTestRegistry();

    expect(
      supportsChannelMessageInteractiveForChannel({
        cfg: {} as OpenClawConfig,
        channel: "discord",
      }),
    ).toBe(true);
    expect(
      supportsChannelMessageInteractiveForChannel({
        cfg: {} as OpenClawConfig,
        channel: "telegram",
      }),
    ).toBe(false);
    expect(
      supportsChannelMessageButtonsForChannel({ cfg: {} as OpenClawConfig, channel: "discord" }),
    ).toBe(true);
    expect(
      supportsChannelMessageButtonsForChannel({ cfg: {} as OpenClawConfig, channel: "telegram" }),
    ).toBe(false);
    expect(
      supportsChannelMessageCardsForChannel({ cfg: {} as OpenClawConfig, channel: "telegram" }),
    ).toBe(true);
    expect(supportsChannelMessageCardsForChannel({ cfg: {} as OpenClawConfig })).toBe(false);
  });
});
