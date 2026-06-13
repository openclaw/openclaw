// Message action tests cover channel message action schema and invocation behavior.
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { defaultRuntime } from "../../runtime.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";
import {
  testing,
  channelSupportsMessageCapability,
  channelSupportsMessageCapabilityForChannel,
  listCrossChannelSchemaSupportedMessageActions,
  listChannelMessageActions,
  listChannelMessageCapabilities,
  listChannelMessageCapabilitiesForChannel,
  resolveChannelMessageToolMediaSourceParamKeys,
  resolveChannelMessageToolSchemaProperties,
} from "./message-action-discovery.js";
import type { ChannelMessageCapability } from "./message-capabilities.js";
import type { ChannelMessageToolSchemaContribution, ChannelPlugin } from "./types.js";

const emptyRegistry = createTestRegistry([]);

function createMessageActionsPlugin(params: {
  id: "demo-buttons" | "demo-cards";
  capabilities: readonly ChannelMessageCapability[];
  aliases?: string[];
}): ChannelPlugin {
  const base = createChannelTestPluginBase({
    id: params.id,
    label: params.id === "demo-buttons" ? "Demo Buttons" : "Demo Cards",
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
  id: "demo-buttons",
  capabilities: ["presentation"],
});

const cardsPlugin = createMessageActionsPlugin({
  id: "demo-cards",
  capabilities: ["delivery-pin"],
});

function activateMessageActionTestRegistry() {
  setActivePluginRegistry(
    createTestRegistry([
      { pluginId: "demo-buttons", source: "test", plugin: buttonsPlugin },
      { pluginId: "demo-cards", source: "test", plugin: cardsPlugin },
    ]),
  );
}

describe("message action capability checks", () => {
  const errorSpy = vi.spyOn(defaultRuntime, "error").mockImplementation(() => undefined);

  afterEach(() => {
    setActivePluginRegistry(emptyRegistry);
    testing.resetLoggedMessageActionErrors();
    errorSpy.mockClear();
  });

  it("aggregates capabilities across plugins", () => {
    activateMessageActionTestRegistry();

    expect(listChannelMessageCapabilities({} as OpenClawConfig).toSorted()).toEqual([
      "delivery-pin",
      "presentation",
    ]);
    expect(channelSupportsMessageCapability({} as OpenClawConfig, "presentation")).toBe(true);
    expect(channelSupportsMessageCapability({} as OpenClawConfig, "delivery-pin")).toBe(true);
  });

  it("checks per-channel capabilities", () => {
    activateMessageActionTestRegistry();

    expect(
      listChannelMessageCapabilitiesForChannel({
        cfg: {} as OpenClawConfig,
        channel: "demo-buttons",
      }),
    ).toEqual(["presentation"]);
    expect(
      listChannelMessageCapabilitiesForChannel({
        cfg: {} as OpenClawConfig,
        channel: "demo-cards",
      }),
    ).toEqual(["delivery-pin"]);
    expect(
      channelSupportsMessageCapabilityForChannel(
        { cfg: {} as OpenClawConfig, channel: "demo-buttons" },
        "presentation",
      ),
    ).toBe(true);
    expect(
      channelSupportsMessageCapabilityForChannel(
        { cfg: {} as OpenClawConfig, channel: "demo-cards" },
        "presentation",
      ),
    ).toBe(false);
    expect(
      channelSupportsMessageCapabilityForChannel(
        { cfg: {} as OpenClawConfig, channel: "demo-buttons" },
        "delivery-pin",
      ),
    ).toBe(false);
    expect(
      channelSupportsMessageCapabilityForChannel(
        { cfg: {} as OpenClawConfig, channel: "demo-cards" },
        "delivery-pin",
      ),
    ).toBe(true);
    expect(
      channelSupportsMessageCapabilityForChannel({ cfg: {} as OpenClawConfig }, "delivery-pin"),
    ).toBe(false);
  });

  it("normalizes channel aliases for per-channel capability checks", () => {
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "demo-cards",
          source: "test",
          plugin: createMessageActionsPlugin({
            id: "demo-cards",
            aliases: ["demo-cards-alias"],
            capabilities: ["delivery-pin"],
          }),
        },
      ]),
    );

    expect(
      listChannelMessageCapabilitiesForChannel({
        cfg: {} as OpenClawConfig,
        channel: "demo-cards-alias",
      }),
    ).toEqual(["delivery-pin"]);
  });

  it("uses unified message tool discovery for actions, capabilities, and schema", () => {
    const unifiedPlugin: ChannelPlugin = {
      ...createChannelTestPluginBase({
        id: "demo-unified",
        label: "Demo Unified",
        capabilities: { chatTypes: ["direct", "group"] },
        config: {
          listAccountIds: () => ["default"],
        },
      }),
      actions: {
        describeMessageTool: () => ({
          actions: ["react"],
          capabilities: ["presentation"],
          schema: {
            properties: {
              components: Type.Array(Type.String()),
            },
          },
        }),
      },
    };
    setActivePluginRegistry(
      createTestRegistry([{ pluginId: "demo-unified", source: "test", plugin: unifiedPlugin }]),
    );

    expect(listChannelMessageActions({} as OpenClawConfig)).toEqual(["send", "broadcast", "react"]);
    expect(listChannelMessageCapabilities({} as OpenClawConfig)).toEqual(["presentation"]);
    expect(
      resolveChannelMessageToolSchemaProperties({
        cfg: {} as OpenClawConfig,
        channel: "demo-unified",
      }),
    ).toHaveProperty("components");
  });

  it("skips unreadable schema contributions without dropping healthy fields", () => {
    const unreadableSchema = {} as ChannelMessageToolSchemaContribution;
    Object.defineProperty(unreadableSchema, "visibility", {
      value: "all-configured",
    });
    Object.defineProperty(unreadableSchema, "properties", {
      get() {
        throw new Error("schema properties exploded");
      },
    });
    const schemaPlugin: ChannelPlugin = {
      ...createChannelTestPluginBase({
        id: "demo-schema-read",
        label: "Demo Schema Read",
        capabilities: { chatTypes: ["direct", "group"] },
        config: {
          listAccountIds: () => ["default"],
        },
      }),
      actions: {
        describeMessageTool: () => ({
          schema: [
            unreadableSchema,
            {
              visibility: "all-configured",
              properties: {
                safeField: Type.Optional(Type.String()),
              },
            },
          ],
        }),
      },
    };
    setActivePluginRegistry(
      createTestRegistry([{ pluginId: "demo-schema-read", source: "test", plugin: schemaPlugin }]),
    );

    expect(
      resolveChannelMessageToolSchemaProperties({
        cfg: {} as OpenClawConfig,
        channel: "demo-schema-read",
      }),
    ).toHaveProperty("safeField");
    expect(errorSpy).toHaveBeenCalledOnce();
  });

  it("skips unreadable schema array entries without dropping healthy entries", () => {
    const schemaEntries = [
      undefined,
      {
        visibility: "all-configured",
        properties: {
          safeField: Type.Optional(Type.String()),
        },
      },
    ] as ChannelMessageToolSchemaContribution[];
    Object.defineProperty(schemaEntries, "0", {
      enumerable: true,
      get() {
        throw new Error("schema array entry exploded");
      },
    });
    const schemaPlugin: ChannelPlugin = {
      ...createChannelTestPluginBase({
        id: "demo-schema-array-read",
        label: "Demo Schema Array Read",
        capabilities: { chatTypes: ["direct", "group"] },
        config: {
          listAccountIds: () => ["default"],
        },
      }),
      actions: {
        describeMessageTool: () => ({
          schema: schemaEntries,
        }),
      },
    };
    setActivePluginRegistry(
      createTestRegistry([
        { pluginId: "demo-schema-array-read", source: "test", plugin: schemaPlugin },
      ]),
    );

    expect(
      resolveChannelMessageToolSchemaProperties({
        cfg: {} as OpenClawConfig,
        channel: "demo-schema-array-read",
      }),
    ).toHaveProperty("safeField");
    expect(errorSpy).toHaveBeenCalledOnce();
  });

  it("fails closed when schema array entries are unreadable for cross-channel actions", () => {
    const schemaEntries = [
      undefined,
      {
        visibility: "all-configured",
        properties: {
          safeField: Type.Optional(Type.String()),
        },
      },
    ] as ChannelMessageToolSchemaContribution[];
    Object.defineProperty(schemaEntries, "0", {
      enumerable: true,
      get() {
        throw new Error("schema array entry exploded");
      },
    });
    const schemaPlugin: ChannelPlugin = {
      ...createChannelTestPluginBase({
        id: "demo-schema-array-cross-channel",
        label: "Demo Schema Array Cross Channel",
        capabilities: { chatTypes: ["direct", "group"] },
        config: {
          listAccountIds: () => ["default"],
        },
      }),
      actions: {
        describeMessageTool: () => ({
          actions: ["read", "unpin"],
          schema: schemaEntries,
        }),
      },
    };
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "demo-schema-array-cross-channel",
          source: "test",
          plugin: schemaPlugin,
        },
      ]),
    );

    expect(
      listCrossChannelSchemaSupportedMessageActions({
        cfg: {} as OpenClawConfig,
        channel: "demo-schema-array-cross-channel",
      }),
    ).toStrictEqual([]);
    expect(errorSpy).toHaveBeenCalledOnce();
  });

  it("skips unreadable schema property fields without dropping healthy siblings", () => {
    const properties = {
      safeField: Type.Optional(Type.String()),
    } as NonNullable<ChannelMessageToolSchemaContribution["properties"]>;
    Object.defineProperty(properties, "badField", {
      enumerable: true,
      get() {
        throw new Error("schema property field exploded");
      },
    });
    const schemaPlugin: ChannelPlugin = {
      ...createChannelTestPluginBase({
        id: "demo-schema-field-read",
        label: "Demo Schema Field Read",
        capabilities: { chatTypes: ["direct", "group"] },
        config: {
          listAccountIds: () => ["default"],
        },
      }),
      actions: {
        describeMessageTool: () => ({
          schema: {
            visibility: "all-configured",
            properties,
          },
        }),
      },
    };
    setActivePluginRegistry(
      createTestRegistry([
        { pluginId: "demo-schema-field-read", source: "test", plugin: schemaPlugin },
      ]),
    );

    expect(
      resolveChannelMessageToolSchemaProperties({
        cfg: {} as OpenClawConfig,
        channel: "demo-schema-field-read",
      }),
    ).toHaveProperty("safeField");
    expect(errorSpy).toHaveBeenCalledOnce();
  });

  it("filters only actions that depend on current-channel-only schema", () => {
    const scopedSchemaPlugin: ChannelPlugin = {
      ...createChannelTestPluginBase({
        id: "demo-scoped-schema",
        label: "Demo Scoped Schema",
        capabilities: { chatTypes: ["direct", "group"] },
        config: {
          listAccountIds: () => ["default"],
        },
      }),
      actions: {
        describeMessageTool: () => ({
          actions: ["read", "list-pins", "unpin"],
          schema: {
            actions: ["unpin"],
            properties: {
              pinnedMessageId: Type.Optional(Type.String()),
            },
          },
        }),
      },
    };
    setActivePluginRegistry(
      createTestRegistry([
        { pluginId: "demo-scoped-schema", source: "test", plugin: scopedSchemaPlugin },
      ]),
    );

    expect(
      listCrossChannelSchemaSupportedMessageActions({
        cfg: {} as OpenClawConfig,
        channel: "demo-scoped-schema",
      }),
    ).toEqual(["read", "list-pins"]);
  });

  it("fails closed when scoped schema action lists are unreadable", () => {
    const unreadableSchema = {
      visibility: "current-channel",
      properties: {
        pinnedMessageId: Type.Optional(Type.String()),
      },
    } as ChannelMessageToolSchemaContribution;
    Object.defineProperty(unreadableSchema, "actions", {
      get() {
        throw new Error("schema actions exploded");
      },
    });
    const scopedSchemaPlugin: ChannelPlugin = {
      ...createChannelTestPluginBase({
        id: "demo-unreadable-scoped-schema",
        label: "Demo Unreadable Scoped Schema",
        capabilities: { chatTypes: ["direct", "group"] },
        config: {
          listAccountIds: () => ["default"],
        },
      }),
      actions: {
        describeMessageTool: () => ({
          actions: ["read", "unpin"],
          schema: unreadableSchema,
        }),
      },
    };
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "demo-unreadable-scoped-schema",
          source: "test",
          plugin: scopedSchemaPlugin,
        },
      ]),
    );

    expect(
      listCrossChannelSchemaSupportedMessageActions({
        cfg: {} as OpenClawConfig,
        channel: "demo-unreadable-scoped-schema",
      }),
    ).toStrictEqual([]);
    expect(errorSpy).toHaveBeenCalledOnce();
  });

  it("keeps unscoped current-channel schema conservative for cross-channel actions", () => {
    const unscopedSchemaPlugin: ChannelPlugin = {
      ...createChannelTestPluginBase({
        id: "demo-unscoped-schema",
        label: "Demo Unscoped Schema",
        capabilities: { chatTypes: ["direct", "group"] },
        config: {
          listAccountIds: () => ["default"],
        },
      }),
      actions: {
        describeMessageTool: () => ({
          actions: ["read", "unpin"],
          schema: {
            properties: {
              pinnedMessageId: Type.Optional(Type.String()),
            },
          },
        }),
      },
    };
    setActivePluginRegistry(
      createTestRegistry([
        { pluginId: "demo-unscoped-schema", source: "test", plugin: unscopedSchemaPlugin },
      ]),
    );

    expect(
      listCrossChannelSchemaSupportedMessageActions({
        cfg: {} as OpenClawConfig,
        channel: "demo-unscoped-schema",
      }),
    ).toStrictEqual([]);
  });

  it("treats empty current-channel schema action lists as blocking no cross-channel actions", () => {
    const emptyScopedSchemaPlugin: ChannelPlugin = {
      ...createChannelTestPluginBase({
        id: "demo-empty-scoped-schema",
        label: "Demo Empty Scoped Schema",
        capabilities: { chatTypes: ["direct", "group"] },
        config: {
          listAccountIds: () => ["default"],
        },
      }),
      actions: {
        describeMessageTool: () => ({
          actions: ["read", "list-pins"],
          schema: {
            actions: [],
            properties: {
              optionalChannelOnlyValue: Type.Optional(Type.String()),
            },
          },
        }),
      },
    };
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "demo-empty-scoped-schema",
          source: "test",
          plugin: emptyScopedSchemaPlugin,
        },
      ]),
    );

    expect(
      listCrossChannelSchemaSupportedMessageActions({
        cfg: {} as OpenClawConfig,
        channel: "demo-empty-scoped-schema",
      }),
    ).toEqual(["read", "list-pins"]);
  });

  it("derives plugin-owned media-source params for the current action", () => {
    const mediaPlugin: ChannelPlugin = {
      ...createChannelTestPluginBase({
        id: "demo-media",
        label: "Demo Media",
        capabilities: { chatTypes: ["direct", "group"] },
        config: {
          listAccountIds: () => ["default"],
        },
      }),
      actions: {
        describeMessageTool: () => ({
          actions: ["send", "set-profile"],
          mediaSourceParams: {
            "set-profile": ["avatarUrl", "avatarPath"],
          },
          schema: {
            properties: {
              avatarUrl: Type.Optional(Type.String({ description: "Remote avatar URL" })),
              avatarPath: Type.Optional(Type.String({ description: "Local avatar path" })),
              displayName: Type.Optional(Type.String()),
            },
          },
        }),
      },
    };
    setActivePluginRegistry(
      createTestRegistry([{ pluginId: "demo-media", source: "test", plugin: mediaPlugin }]),
    );

    expect(
      resolveChannelMessageToolMediaSourceParamKeys({
        cfg: {} as OpenClawConfig,
        action: "set-profile",
        channel: "demo-media",
      }),
    ).toEqual(["avatarUrl", "avatarPath"]);
    expect(
      resolveChannelMessageToolMediaSourceParamKeys({
        cfg: {} as OpenClawConfig,
        action: "send",
        channel: "demo-media",
      }),
    ).toStrictEqual([]);
  });

  it("keeps flat media-source param discovery for backward compatibility", () => {
    const mediaPlugin: ChannelPlugin = {
      ...createChannelTestPluginBase({
        id: "demo-media-flat",
        label: "Demo Media Flat",
        capabilities: { chatTypes: ["direct", "group"] },
        config: {
          listAccountIds: () => ["default"],
        },
      }),
      actions: {
        describeMessageTool: () => ({
          actions: ["set-profile"],
          mediaSourceParams: ["avatarUrl", "avatarPath"],
        }),
      },
    };
    setActivePluginRegistry(
      createTestRegistry([{ pluginId: "demo-media-flat", source: "test", plugin: mediaPlugin }]),
    );

    expect(
      resolveChannelMessageToolMediaSourceParamKeys({
        cfg: {} as OpenClawConfig,
        action: "set-profile",
        channel: "demo-media-flat",
      }),
    ).toEqual(["avatarUrl", "avatarPath"]);
  });

  it("skips crashing action/capability discovery paths and logs once", () => {
    const crashingPlugin: ChannelPlugin = {
      ...createChannelTestPluginBase({
        id: "demo-crashing",
        label: "Demo Crashing",
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
      createTestRegistry([{ pluginId: "demo-crashing", source: "test", plugin: crashingPlugin }]),
    );

    expect(listChannelMessageActions({} as OpenClawConfig)).toEqual(["send", "broadcast"]);
    expect(listChannelMessageCapabilities({} as OpenClawConfig)).toStrictEqual([]);
    expect(errorSpy).toHaveBeenCalledTimes(1);

    expect(listChannelMessageActions({} as OpenClawConfig)).toEqual(["send", "broadcast"]);
    expect(listChannelMessageCapabilities({} as OpenClawConfig)).toStrictEqual([]);
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });
});
