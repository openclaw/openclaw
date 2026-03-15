import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { defaultRuntime } from "../../runtime.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";
import {
  _resetActionProbeErrorLogForTest,
  listChannelMessageActions,
  supportsChannelMessageButtons,
  supportsChannelMessageButtonsForChannel,
  supportsChannelMessageCards,
  supportsChannelMessageCardsForChannel,
} from "./message-actions.js";
import type { ChannelPlugin } from "./types.js";

const emptyRegistry = createTestRegistry([]);

function createMessageActionsPlugin(params: {
  id: "discord" | "telegram";
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
      supportsButtons: () => params.supportsButtons,
      supportsCards: () => params.supportsCards,
    },
  };
}

const buttonsPlugin = createMessageActionsPlugin({
  id: "discord",
  supportsButtons: true,
  supportsCards: false,
});

const cardsPlugin = createMessageActionsPlugin({
  id: "telegram",
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
    _resetActionProbeErrorLogForTest();
    vi.restoreAllMocks();
  });

  it("aggregates buttons/card support across plugins", () => {
    activateMessageActionTestRegistry();

    expect(supportsChannelMessageButtons({} as OpenClawConfig)).toBe(true);
    expect(supportsChannelMessageCards({} as OpenClawConfig)).toBe(true);
  });

  it("checks per-channel capabilities", () => {
    activateMessageActionTestRegistry();

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

  it("ignores SecretRef probe failures while aggregating capabilities", () => {
    const brokenPlugin: ChannelPlugin = {
      ...createChannelTestPluginBase({
        id: "telegram",
        label: "Telegram",
        capabilities: { chatTypes: ["direct", "group"] },
        config: {
          listAccountIds: () => ["default"],
        },
      }),
      actions: {
        listActions: () => {
          throw new Error("unresolved SecretRef");
        },
        supportsButtons: () => {
          throw new Error("unresolved SecretRef");
        },
        supportsCards: () => {
          throw new Error("unresolved SecretRef");
        },
      },
    };

    setActivePluginRegistry(
      createTestRegistry([
        { pluginId: "discord", source: "test", plugin: buttonsPlugin },
        { pluginId: "telegram", source: "test", plugin: brokenPlugin },
      ]),
    );

    expect(listChannelMessageActions({} as OpenClawConfig)).toEqual(["send", "broadcast"]);
    expect(supportsChannelMessageButtons({} as OpenClawConfig)).toBe(true);
    expect(supportsChannelMessageCards({} as OpenClawConfig)).toBe(false);
    expect(
      supportsChannelMessageButtonsForChannel({ cfg: {} as OpenClawConfig, channel: "telegram" }),
    ).toBe(false);
  });

  it("rethrows non-SecretRef probe failures", () => {
    const brokenPlugin: ChannelPlugin = {
      ...createChannelTestPluginBase({
        id: "telegram",
        label: "Telegram",
        capabilities: { chatTypes: ["direct", "group"] },
        config: {
          listAccountIds: () => ["default"],
        },
      }),
      actions: {
        listActions: () => {
          throw new TypeError("cannot read properties of undefined");
        },
      },
    };

    setActivePluginRegistry(
      createTestRegistry([{ pluginId: "telegram", source: "test", plugin: brokenPlugin }]),
    );

    expect(() => listChannelMessageActions({} as OpenClawConfig)).toThrow(
      "cannot read properties of undefined",
    );
  });

  it("resets deduped SecretRef probe logging between tests", () => {
    const errorSpy = vi.fn();
    defaultRuntime.error = errorSpy;

    const brokenPlugin: ChannelPlugin = {
      ...createChannelTestPluginBase({
        id: "telegram",
        label: "Telegram",
        capabilities: { chatTypes: ["direct", "group"] },
        config: {
          listAccountIds: () => ["default"],
        },
      }),
      actions: {
        listActions: () => {
          throw new Error("unresolved SecretRef");
        },
      },
    };

    setActivePluginRegistry(
      createTestRegistry([{ pluginId: "telegram", source: "test", plugin: brokenPlugin }]),
    );

    expect(listChannelMessageActions({} as OpenClawConfig)).toEqual(["send", "broadcast"]);
    expect(errorSpy).toHaveBeenCalledTimes(1);

    _resetActionProbeErrorLogForTest();
    expect(listChannelMessageActions({} as OpenClawConfig)).toEqual(["send", "broadcast"]);
    expect(errorSpy).toHaveBeenCalledTimes(2);
  });
});
