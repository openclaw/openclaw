import { expectDefined } from "@openclaw/normalization-core";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { readDeliveryMock, getChannelPluginMock, getBootstrapChannelPluginMock } = vi.hoisted(
  () => ({
    readDeliveryMock: vi.fn(),
    getChannelPluginMock: vi.fn(),
    getBootstrapChannelPluginMock: vi.fn(),
  }),
);

vi.mock("../../channels/plugins/bootstrap-registry.js", () => ({
  getBootstrapChannelPlugin: getBootstrapChannelPluginMock,
}));
vi.mock("../../config/sessions/delivery-info.js", () => ({
  readExactSessionDeliveryContext: readDeliveryMock,
}));
vi.mock("../../channels/plugins/index.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../channels/plugins/index.js")>()),
  getChannelPlugin: getChannelPluginMock,
}));

import type { PreparedMessageToolCatalog } from "../../channels/plugins/message-action-discovery.js";
import { resolveBundledChannelMessageToolDiscoveryAdapter } from "../../channels/plugins/message-tool-api.js";
import type { ChannelMessageActionDiscoveryContext } from "../../channels/plugins/types.public.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { settlePreparedMessageToolCatalog } from "../../plugins/prepared-message-tool-catalog.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";
import {
  buildMessageToolDescription,
  buildMessageToolSchema,
  resolveMessageToolActionSchemaActions,
  resolveEffectiveCurrentChannelContext,
  type MessageToolDiscoveryParams,
} from "./message-tool-discovery.js";

const canonicalSpace = "spaces/AAQA1bC2dEf";
const foldedSpace = "spaces/aaqa1bc2def";
const options = {
  currentChannelProvider: "webchat",
  agentSessionKey: `agent:main:googlechat:group:${foldedSpace}`,
};
const request = { config: {}, action: "send" as const, params: {} };

describe("session-derived message destinations", () => {
  beforeEach(() => {
    getBootstrapChannelPluginMock.mockReset();
    readDeliveryMock.mockReset();
    readDeliveryMock.mockReturnValue({
      channel: "googlechat",
      to: `googlechat:${canonicalSpace}`,
      accountId: "default",
    });
    getChannelPluginMock.mockReset();
    getChannelPluginMock.mockReturnValue({
      config: { listAccountIds: () => ["default"] },
      messaging: { targetIdComparison: "case-sensitive" },
    });
  });

  it("uses the current session's canonical destination without changing the route", () => {
    expect(resolveEffectiveCurrentChannelContext(options, request)).toEqual({
      accountId: undefined,
      currentChannelProvider: "googlechat",
      currentChannelId: canonicalSpace,
      currentMessagingTarget: canonicalSpace,
      currentChatType: "group",
      currentThreadTs: undefined,
    });
  });

  it.each([
    { name: "selected aliases", selected: true, hasAliases: true, expected: foldedSpace },
    { name: "selected absence", selected: true, hasAliases: false, expected: canonicalSpace },
    { name: "unselected bootstrap", selected: false, hasAliases: false, expected: foldedSpace },
  ])(
    "uses $name when deciding whether to recover a destination",
    ({ selected, hasAliases, expected }) => {
      getBootstrapChannelPluginMock.mockReturnValue({
        actions: { messageActionTargetAliases: { read: { aliases: ["messageId"] } } },
      });
      const channels: PreparedMessageToolCatalog["channels"] = hasAliases
        ? [
            {
              id: "googlechat",
              reconcilesUnknownSend: false,
              actions: {
                describeMessageTool: () => ({ actions: ["read"] }),
                messageActionTargetAliases: { read: { aliases: ["messageId"] } },
              },
            },
          ]
        : [];
      const catalog = {
        version: 1,
        channels,
        getChannel: (id: string) => channels.find((entry) => entry.id === id),
      };
      expect(
        resolveEffectiveCurrentChannelContext(options, {
          ...request,
          action: "read",
          params: { messageId: "message-1" },
          preparedMessageToolCatalog: selected ? catalog : undefined,
        }).currentMessagingTarget,
      ).toBe(expected);
      if (selected) {
        expect(getBootstrapChannelPluginMock).not.toHaveBeenCalled();
      }
    },
  );

  it.each([
    { name: "missing delivery", delivery: undefined },
    { name: "another channel", delivery: { channel: "slack", to: canonicalSpace } },
    { name: "another peer", delivery: { channel: "googlechat", to: "spaces/Other" } },
    {
      name: "another account",
      delivery: { channel: "googlechat", to: canonicalSpace, accountId: "other" },
    },
  ])("keeps the inferred destination for $name", ({ delivery }) => {
    readDeliveryMock.mockReturnValue(delivery);
    expect(resolveEffectiveCurrentChannelContext(options, request).currentMessagingTarget).toBe(
      foldedSpace,
    );
  });

  it.each([
    { target: "spaces/Explicit" },
    { to: "spaces/Explicit" },
    { channelId: "spaces/Explicit" },
    { targets: ["spaces/Explicit"] },
  ])("does not recover an explicitly addressed action %j", (params) => {
    expect(
      resolveEffectiveCurrentChannelContext(options, { ...request, params }).currentMessagingTarget,
    ).toBe(foldedSpace);
    expect(readDeliveryMock).not.toHaveBeenCalled();
  });

  it("does not read delivery while discovering a reusable tool", () => {
    resolveEffectiveCurrentChannelContext(options);
    expect(readDeliveryMock).not.toHaveBeenCalled();
  });

  it("keeps lowercase-canonical channels free of delivery reads", () => {
    getChannelPluginMock.mockReturnValue({ messaging: { targetIdComparison: "lowercase" } });
    expect(resolveEffectiveCurrentChannelContext(options, request).currentMessagingTarget).toBe(
      foldedSpace,
    );
    expect(readDeliveryMock).not.toHaveBeenCalled();
  });

  it("keeps a normal inbound destination", () => {
    const inbound = {
      ...options,
      currentChannelProvider: "googlechat",
      currentChannelId: canonicalSpace,
    };
    expect(resolveEffectiveCurrentChannelContext(inbound, request).currentChannelId).toBe(
      canonicalSpace,
    );
    expect(readDeliveryMock).not.toHaveBeenCalled();
  });

  it("preserves the account and thread encoded by a direct route", () => {
    readDeliveryMock.mockReturnValue({
      channel: "googlechat",
      to: canonicalSpace,
      accountId: "work",
    });
    const direct = {
      ...options,
      agentSessionKey: `agent:main:googlechat:work:direct:${foldedSpace}:thread:Thread1`,
    };
    expect(
      resolveEffectiveCurrentChannelContext(direct, { ...request, accountId: "work" }),
    ).toMatchObject({
      accountId: "work",
      currentChatType: "direct",
      currentThreadTs: "Thread1",
      currentChannelId: canonicalSpace,
      currentMessagingTarget: canonicalSpace,
    });
  });
});

describe("message tool discovery cache stability", () => {
  it.each([
    { allow: undefined, expected: ["poll", "poll-vote", "react", "send"] },
    { allow: ["send", "react", "poll", "react"], expected: ["poll", "react", "send"] },
    { allow: ["read", "edit", "read"], expected: ["edit", "read"] },
  ])("keeps schema bytes stable across channel discovery order ($allow)", ({ allow, expected }) => {
    const channels: PreparedMessageToolCatalog["channels"] = [
      {
        id: "telegram",
        reconcilesUnknownSend: false,
        actions: { describeMessageTool: () => ({ actions: ["send", "react", "poll"] }) },
      },
      {
        id: "discord",
        reconcilesUnknownSend: false,
        actions: { describeMessageTool: () => ({ actions: ["send", "poll", "poll-vote"] }) },
      },
    ];
    const createTool = (
      orderedChannels: PreparedMessageToolCatalog["channels"],
      currentChannelProvider: string,
    ) => {
      const params = {
        cfg: { tools: { message: { actions: { allow } } } },
        currentChannelProvider,
        preparedMessageToolCatalog: {
          version: 1,
          channels: orderedChannels,
          getChannel: (id: string) => orderedChannels.find((channel) => channel.id === id),
        },
      };
      const actions = resolveMessageToolActionSchemaActions(params);
      return {
        parameters: buildMessageToolSchema(params, actions),
        description: buildMessageToolDescription(actions),
      };
    };
    const tools = [
      createTool(channels, "telegram"),
      createTool(channels.toReversed(), "discord"),
    ] as const;

    expect(tools[0].description).toBe(tools[1].description);
    expect(JSON.stringify(tools[0].parameters)).toBe(JSON.stringify(tools[1].parameters));
    for (const tool of tools) {
      expect(tool.parameters.properties.action).toMatchObject({ enum: expected });
      if (allow) {
        expect(tool.description).not.toContain("poll-vote");
      }
    }
  });
});

describe("message tool discovery without a current channel", () => {
  it.each([
    { allow: undefined, actions: ["broadcast", "send"], compact: true },
    { allow: ["broadcast"], actions: ["broadcast"], compact: true },
    { allow: ["send", "react"], actions: ["react", "send"], compact: false },
  ])("keeps the fields needed by $actions", ({ allow, actions, compact }) => {
    const deliveryTag = Type.Optional(Type.String());
    const channels: PreparedMessageToolCatalog["channels"] = [
      {
        id: "telegram",
        reconcilesUnknownSend: false,
        actions: {
          describeMessageTool: () => ({
            actions: compact ? ["send"] : ["send", "react"],
            capabilities: ["presentation", "delivery-pin"],
            schema: { visibility: "all-configured", properties: { deliveryTag } },
          }),
        },
      },
    ];
    const params: MessageToolDiscoveryParams = {
      cfg: { tools: { message: { actions: { allow } } } },
      preparedMessageToolCatalog: {
        version: 1,
        channels,
        getChannel: (id) => channels.find((channel) => channel.id === id),
      },
    };
    const discovered = resolveMessageToolActionSchemaActions(params);
    const schema = buildMessageToolSchema(params, discovered);
    const properties = expectDefined(
      asOptionalRecord(schema.properties),
      "message schema properties",
    );

    expect(discovered).toEqual(actions);
    for (const field of ["target", "targets", "media", "attachments", "presentation", "delivery"]) {
      expect(properties).toHaveProperty(field);
    }
    expect(properties.deliveryTag).toEqual(deliveryTag);
    for (const field of ["messageId", "pollId", "eventName", "deleteDays", "activityState"]) {
      expect(Object.hasOwn(properties, field)).toBe(!compact);
    }
    const payload = {
      action: compact ? "broadcast" : "send",
      target: "telegram:chat:one",
      targets: ["telegram:chat:one", "telegram:chat:two"],
      message: "Hello",
      attachments: [{ type: "file", media: "https://example.com/report.txt" }],
      presentation: { blocks: [{ type: "text", text: "Report" }] },
      delivery: { pin: true },
      deliveryTag: "report",
    };
    expect(Value.Check(schema, payload)).toBe(true);
    expect(Value.Check(schema, { ...payload, deliveryTag: 1 })).toBe(false);
  });
});

describe("scheduled account discovery", () => {
  const cfg: OpenClawConfig = {
    channels: {
      slack: {
        accounts: {
          ops: { botToken: "xoxb-scheduled-discovery" },
          disabled: { enabled: false, botToken: "xoxb-disabled-discovery" },
        },
      },
    },
  };

  beforeEach(() => {
    getBootstrapChannelPluginMock.mockReset();
    getChannelPluginMock.mockReset();
  });
  afterEach(() => resetPluginRuntimeStateForTest());

  function registerChannels(foreignContexts?: ChannelMessageActionDiscoveryContext[]) {
    const slack = {
      ...createChannelTestPluginBase({ id: "slack" }),
      actions: expectDefined(
        resolveBundledChannelMessageToolDiscoveryAdapter("slack"),
        "Slack public message-tool discovery adapter",
      ),
    };
    const registry = createTestRegistry([
      { pluginId: "slack", source: "test", plugin: slack },
      ...(foreignContexts
        ? [
            {
              pluginId: "telegram",
              source: "test",
              plugin: {
                ...createChannelTestPluginBase({ id: "telegram" }),
                actions: {
                  describeMessageTool: (context: ChannelMessageActionDiscoveryContext) => {
                    foreignContexts.push(context);
                    return {
                      actions: context.accountId === "disabled" ? ["send", "poll"] : ["send"],
                      schema: {
                        visibility: "all-configured",
                        properties: {
                          foreignHint: Type.Optional(
                            Type.String({ description: `Account: ${String(context.accountId)}` }),
                          ),
                        },
                      },
                    };
                  },
                },
              },
            },
          ]
        : []),
    ]);
    setActivePluginRegistry(registry);
    return expectDefined(settlePreparedMessageToolCatalog(registry), "prepared message catalog");
  }

  function discover(params: MessageToolDiscoveryParams) {
    const actions = resolveMessageToolActionSchemaActions(params);
    const schema = buildMessageToolSchema(params, actions);
    return {
      actions,
      schema,
      properties: expectDefined(asOptionalRecord(schema.properties), "message schema properties"),
      description: buildMessageToolDescription(actions),
    };
  }

  it.each([
    { origin: "external", owner: "ops", delivery: "disabled", readable: true },
    { origin: "external", owner: "disabled", delivery: "ops", readable: false },
    { origin: "local", owner: "ops", delivery: "disabled", readable: true },
    { origin: "local", owner: "disabled", delivery: "ops", readable: false },
  ])(
    "uses the $origin creator account $owner instead of delivery account $delivery",
    ({ origin, owner, delivery, readable }) => {
      registerChannels();
      const result = discover({
        cfg,
        currentChannelProvider: origin === "external" ? "slack" : undefined,
        currentAccountId: delivery,
        scheduledAccountScope: {
          ...(origin === "external" ? { channels: ["slack"] } : {}),
          accountId: owner,
        },
      });

      expect(result.actions.includes("read")).toBe(readable);
      expect(
        Value.Check(result.schema, {
          action: "read",
          channel: "slack",
          target: "channel:C123",
          limit: 1,
        }),
      ).toBe(readable);
      expect(result.properties.topLevel !== undefined).toBe(readable);
      expect(result.properties.presentation !== undefined).toBe(readable);
      expect(result.description.includes("read")).toBe(readable);
    },
  );

  it.each([
    [undefined, false],
    [undefined, true],
    ["slack", false],
    ["slack", true],
    ["telegram", false],
    ["telegram", true],
  ] as const)(
    "preserves foreign discovery for primary %s (prepared catalog: %s)",
    (currentChannelProvider, prepared) => {
      const foreignContexts: ChannelMessageActionDiscoveryContext[] = [];
      const catalog = registerChannels(foreignContexts);
      const params: MessageToolDiscoveryParams = {
        cfg,
        currentChannelProvider,
        currentAccountId: "disabled",
        currentChannelId: "delivery-room",
        currentChatType: "channel",
        currentThreadTs: "delivery-thread",
        currentMessageId: "delivery-message",
        sessionKey: "agent:main:cron:scheduled-read",
        sessionId: "scheduled-session",
        ...(prepared ? { preparedMessageToolCatalog: catalog } : {}),
      };
      const baseline = discover(params);
      const baselineContexts = foreignContexts.splice(0);
      const scoped = discover({
        ...params,
        scheduledAccountScope: { channels: ["slack"], accountId: "ops" },
      });

      expect(scoped.actions).toContain("read");
      expect(baseline.actions).not.toContain("read");
      expect(scoped.actions).toContain("poll");
      expect(baseline.properties).toHaveProperty("foreignHint");
      expect(scoped.properties.foreignHint).toEqual(baseline.properties.foreignHint);
      expect(foreignContexts).toEqual(baselineContexts);
      expect(
        Value.Check(scoped.schema, {
          action: "send",
          channel: "telegram",
          target: "chat:delivery",
          message: "hello",
          foreignHint: "retained",
        }),
      ).toBe(true);
    },
  );
});
