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
  channelSupportsMessageCapability,
  channelSupportsMessageCapabilityForChannel,
  listChannelMessageActions,
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
    _resetActionProbeErrorLogForTest();
    vi.restoreAllMocks();
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
        getCapabilities: () => {
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
    expect(listChannelMessageCapabilities({} as OpenClawConfig).toSorted()).toEqual([
      "buttons",
      "interactive",
    ]);
    expect(channelSupportsMessageCapability({} as OpenClawConfig, "cards")).toBe(false);
    expect(
      listChannelMessageCapabilitiesForChannel({
        cfg: {} as OpenClawConfig,
        channel: "telegram",
      }),
    ).toEqual([]);
    expect(
      channelSupportsMessageCapabilityForChannel(
        { cfg: {} as OpenClawConfig, channel: "telegram" },
        "cards",
      ),
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

  it("resets deduped SecretRef probe logging between checks", () => {
    const errorSpy = vi.fn();
    const previousError = defaultRuntime.error;
    defaultRuntime.error = errorSpy;

    try {
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

      expect(listChannelMessageActions({} as OpenClawConfig)).toEqual(["send", "broadcast"]);
      expect(errorSpy).toHaveBeenCalledTimes(1);

      _resetActionProbeErrorLogForTest();
      expect(listChannelMessageActions({} as OpenClawConfig)).toEqual(["send", "broadcast"]);
      expect(errorSpy).toHaveBeenCalledTimes(2);
    } finally {
      defaultRuntime.error = previousError;
    }
  });
});
