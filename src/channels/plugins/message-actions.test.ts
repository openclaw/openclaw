import { Type } from "@sinclair/typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { defaultRuntime } from "../../runtime.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";
import {
  __testing,
  channelSupportsMessageCapability,
  channelSupportsMessageCapabilityForChannel,
  listChannelMessageActions,
  listChannelMessageCapabilities,
  listChannelMessageCapabilitiesForChannel,
  resolveChannelMessageToolSchemaProperties,
} from "./message-action-discovery.js";
import type { ChannelMessageCapability } from "./message-capabilities.js";
import type { ChannelPlugin } from "./types.js";

const emptyRegistry = createTestRegistry([]);

function createMessageActionsPlugin(params: {
  id: "discord" | "telegram";
  capabilities: readonly ChannelMessageCapability[];
  aliases?: string[];
}): ChannelPlugin {
  const base = createChannelTestPluginBase({
    id: params.id,
    label: params.id === "discord" ? "Discord" : "Telegram",
    capabilities: { chatTypes: ["direct", "group"] },
    config: {
      listAccountIds: () => ["default"],
    },
  });
  return {
    ...base,
    meta: {
      ...base.meta,
      ...(params.aliases ? { aliases: params.aliases } : {}),
    },
    actions: {
      describeMessageTool: () => ({
        actions: ["send"],
        capabilities: params.capabilities,
      }),
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
  const errorSpy = vi.spyOn(defaultRuntime, "error").mockImplementation(() => undefined);

  afterEach(() => {
    setActivePluginRegistry(emptyRegistry);
    __testing.resetLoggedMessageActionErrors();
    errorSpy.mockClear();
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

  it("normalizes channel aliases for per-channel capability checks", () => {
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "telegram",
          source: "test",
          plugin: createMessageActionsPlugin({
            id: "telegram",
            aliases: ["tg"],
            capabilities: ["cards"],
          }),
        },
      ]),
    );

    expect(
      listChannelMessageCapabilitiesForChannel({
        cfg: {} as OpenClawConfig,
        channel: "tg",
      }),
    ).toEqual(["cards"]);
  });

  it("uses unified message tool discovery for actions, capabilities, and schema", () => {
    const unifiedPlugin: ChannelPlugin = {
      ...createChannelTestPluginBase({
        id: "discord",
        label: "Discord",
        capabilities: { chatTypes: ["direct", "group"] },
        config: {
          listAccountIds: () => ["default"],
        },
      }),
      actions: {
        describeMessageTool: () => ({
          actions: ["react"],
          capabilities: ["interactive"],
          schema: {
            properties: {
              components: Type.Array(Type.String()),
            },
          },
        }),
      },
    };
    setActivePluginRegistry(
      createTestRegistry([{ pluginId: "discord", source: "test", plugin: unifiedPlugin }]),
    );

    expect(listChannelMessageActions({} as OpenClawConfig)).toEqual(["send", "broadcast", "react"]);
    expect(listChannelMessageCapabilities({} as OpenClawConfig)).toEqual(["interactive"]);
    expect(
      resolveChannelMessageToolSchemaProperties({
        cfg: {} as OpenClawConfig,
        channel: "discord",
      }),
    ).toHaveProperty("components");
  });

  it("skips crashing action/capability discovery paths and logs once", () => {
    const crashingPlugin: ChannelPlugin = {
      ...createChannelTestPluginBase({
        id: "discord",
        label: "Discord",
        capabilities: { chatTypes: ["direct", "group"] },
        config: {
          listAccountIds: () => ["default"],
        },
      }),
      actions: {
        describeMessageTool: () => {
          throw new Error("boom");
        },
      },
    };
    setActivePluginRegistry(
      createTestRegistry([{ pluginId: "discord", source: "test", plugin: crashingPlugin }]),
    );

    expect(listChannelMessageActions({} as OpenClawConfig)).toEqual(["send", "broadcast"]);
    expect(listChannelMessageCapabilities({} as OpenClawConfig)).toEqual([]);
    expect(errorSpy).toHaveBeenCalledTimes(1);

    expect(listChannelMessageActions({} as OpenClawConfig)).toEqual(["send", "broadcast"]);
    expect(listChannelMessageCapabilities({} as OpenClawConfig)).toEqual([]);
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });
});
