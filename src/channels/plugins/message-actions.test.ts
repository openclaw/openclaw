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

  it("prefers unified message tool discovery over legacy discovery methods", () => {
    const legacyListActions = vi.fn(() => {
      throw new Error("legacy listActions should not run");
    });
    const legacyCapabilities = vi.fn(() => {
      throw new Error("legacy getCapabilities should not run");
    });
    const legacySchema = vi.fn(() => {
      throw new Error("legacy getToolSchema should not run");
    });
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
        listActions: legacyListActions,
        getCapabilities: legacyCapabilities,
        getToolSchema: legacySchema,
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
    expect(legacyListActions).not.toHaveBeenCalled();
    expect(legacyCapabilities).not.toHaveBeenCalled();
    expect(legacySchema).not.toHaveBeenCalled();
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
        listActions: () => {
          throw new Error("boom");
        },
        getCapabilities: () => {
          throw new Error("boom");
        },
      },
    };
    setActivePluginRegistry(
      createTestRegistry([{ pluginId: "discord", source: "test", plugin: crashingPlugin }]),
    );

    expect(listChannelMessageActions({} as OpenClawConfig)).toEqual(["send", "broadcast"]);
    expect(listChannelMessageCapabilities({} as OpenClawConfig)).toEqual([]);
    expect(errorSpy).toHaveBeenCalledTimes(2);

    expect(listChannelMessageActions({} as OpenClawConfig)).toEqual(["send", "broadcast"]);
    expect(listChannelMessageCapabilities({} as OpenClawConfig)).toEqual([]);
    expect(errorSpy).toHaveBeenCalledTimes(2);
  });
});
