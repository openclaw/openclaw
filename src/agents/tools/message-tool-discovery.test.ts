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
import type {
  ChannelMessageActionDiscoveryContext,
  ChannelMessageToolDiscovery,
  ChannelMessageToolSchemaContribution,
} from "../../channels/plugins/types.public.js";
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
  hasMessageToolSourceConversation,
  resolveMessageToolActionSchemaActions,
  resolveEffectiveCurrentChannelContextForRequest,
  resolveMessageToolDiscoveryAsync,
  type MessageToolDiscoveryParams,
} from "./message-tool-discovery.js";

const canonicalSpace = "spaces/AAQA1bC2dEf";
const foldedSpace = "spaces/aaqa1bc2def";
const options = {
  currentChannelProvider: "webchat",
  agentSessionKey: `agent:main:googlechat:group:${foldedSpace}`,
};
const request = { config: {}, action: "send" as const, params: {} };
type DiscoveryChannel = PreparedMessageToolCatalog["channels"][number];
function channel(
  id: string,
  actions: ChannelMessageToolDiscovery["actions"],
  properties?: ChannelMessageToolSchemaContribution["properties"],
  capabilities?: ChannelMessageToolDiscovery["capabilities"],
) {
  return {
    id,
    reconcilesUnknownSend: false,
    actions: {
      describeMessageTool: () => ({
        actions,
        capabilities,
        ...(properties && { schema: { visibility: "all-configured", properties } }),
      }),
    },
  } satisfies DiscoveryChannel;
}
function catalog(channels: PreparedMessageToolCatalog["channels"]): PreparedMessageToolCatalog {
  return { version: 1, channels, getChannel: (id) => channels.find((entry) => entry.id === id) };
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
  [undefined, false],
  [{ currentChannelProvider: "telegram" }, false],
  [{ currentChannelId: "123" }, false],
  [{ currentChannelProvider: "telegram", currentChannelId: "heartbeat" }, false],
  [{ currentChannelProvider: "telegram", currentChannelId: "channel:agent:main:main" }, false],
  [{ currentChannelProvider: "telegram", currentMessagingTarget: "123" }, true],
  [{ currentChannelProvider: "webchat", agentSessionKey: "agent:main:telegram:direct:123" }, true],
] as const)("reports source routing for %o", (context, expected) => {
  expect(hasMessageToolSourceConversation(context)).toBe(expected);
});

describe("session-derived message destinations", () => {
  beforeEach(() => {
    getBootstrapChannelPluginMock.mockReset();
    readDeliveryMock.mockReset().mockReturnValue({
      channel: "googlechat",
      to: `googlechat:${canonicalSpace}`,
      accountId: "default",
    });
    getChannelPluginMock.mockReset().mockReturnValue({
      config: { listAccountIds: () => ["default"] },
      messaging: { targetIdComparison: "case-sensitive" },
    });
  });

  it.each([
    ["canonical group", "googlechat", `googlechat:${canonicalSpace}`, "default", canonicalSpace],
    ["missing delivery", undefined, undefined, undefined, foldedSpace],
    ["another channel", "slack", canonicalSpace, undefined, foldedSpace],
    ["another peer", "googlechat", "spaces/Other", undefined, foldedSpace],
    ["another account", "googlechat", canonicalSpace, "other", foldedSpace],
    ["direct account and thread", "googlechat", canonicalSpace, "work", canonicalSpace],
  ])("recovers only the matching route: %s", async (_name, provider, to, accountId, expected) => {
    const direct = accountId === "work";
    readDeliveryMock.mockReturnValue(provider ? { channel: provider, to, accountId } : undefined);
    expect(
      await resolveEffectiveCurrentChannelContextForRequest(
        direct
          ? {
              ...options,
              agentSessionKey: `agent:main:googlechat:work:direct:${foldedSpace}:thread:Thread1`,
            }
          : options,
        direct ? { ...request, accountId: "work" } : request,
      ),
    ).toEqual({
      accountId: direct ? "work" : undefined,
      currentChannelProvider: "googlechat",
      currentChannelId: expected,
      currentMessagingTarget: expected,
      currentChatType: direct ? "direct" : "group",
      currentThreadTs: direct ? "Thread1" : undefined,
    });
  });

  it.each([
    { name: "selected aliases", selected: true, hasAliases: true, expected: foldedSpace },
    { name: "selected absence", selected: true, hasAliases: false, expected: canonicalSpace },
    { name: "unselected bootstrap", selected: false, hasAliases: false, expected: foldedSpace },
  ])(
    "uses $name when deciding whether to recover a destination",
    async ({ selected, hasAliases, expected }) => {
      getBootstrapChannelPluginMock.mockReturnValue({
        actions: { messageActionTargetAliases: { read: { aliases: ["messageId"] } } },
      });
      const readChannel = channel("googlechat", ["read"]);
      const selectedCatalog = catalog(
        hasAliases
          ? [
              {
                ...readChannel,
                actions: {
                  ...readChannel.actions,
                  messageActionTargetAliases: { read: { aliases: ["messageId"] } },
                },
              },
            ]
          : [],
      );
      expect(
        (
          await resolveEffectiveCurrentChannelContextForRequest(options, {
            ...request,
            action: "read",
            params: { messageId: "message-1" },
            preparedMessageToolCatalog: selected ? selectedCatalog : undefined,
          })
        ).currentMessagingTarget,
      ).toBe(expected);
      if (selected) {
        expect(getBootstrapChannelPluginMock).not.toHaveBeenCalled();
      }
    },
  );

  it.each<{
    name: string;
    params?: Record<string, unknown>;
    discovery?: boolean;
    lowercase?: boolean;
    inbound?: boolean;
  }>([
    { name: "explicit target", params: { target: "spaces/Explicit" } },
    { name: "explicit to", params: { to: "spaces/Explicit" } },
    { name: "explicit channelId", params: { channelId: "spaces/Explicit" } },
    { name: "explicit targets", params: { targets: ["spaces/Explicit"] } },
    { name: "reusable discovery", discovery: true },
    { name: "lowercase-canonical channel", lowercase: true },
    { name: "normal inbound destination", inbound: true },
  ])("avoids delivery reads for $name", async ({ params, discovery, lowercase, inbound }) => {
    if (lowercase) {
      getChannelPluginMock.mockReturnValue({ messaging: { targetIdComparison: "lowercase" } });
    }
    const result = await resolveEffectiveCurrentChannelContextForRequest(
      inbound
        ? { ...options, currentChannelProvider: "googlechat", currentChannelId: canonicalSpace }
        : options,
      discovery ? undefined : { ...request, params: params ?? {} },
    );
    if (inbound) {
      expect(result.currentChannelId).toBe(canonicalSpace);
    } else if (!discovery) {
      expect(result.currentMessagingTarget).toBe(foldedSpace);
    }
    expect(readDeliveryMock).not.toHaveBeenCalled();
  });
});

describe("message tool discovery cache stability", () => {
  it("limits actions and fields to the session's channel bindings with stable bytes", async () => {
    const channels = [
      channel("qa-primary", ["send", "react"], {
        primaryLabel: Type.Optional(Type.String()),
      }),
      channel("qa-secondary", ["send", "poll"], { ballotLabel: Type.Optional(Type.String()) }, [
        "presentation",
      ]),
      channel("qa-unrelated", ["event-create"], { unrelatedLabel: Type.Optional(Type.String()) }),
    ];
    const discoverBindings = (bindings: OpenClawConfig["bindings"], orderedChannels = channels) =>
      resolveMessageToolDiscoveryAsync({
        cfg: { bindings },
        agentId: "main",
        currentChannelProvider: "qa-primary",
        preparedMessageToolCatalog: catalog(orderedChannels),
      });
    const single = await discoverBindings([]);
    expect(single.actions).toEqual(["react", "send"]);
    expect(single.schema.properties).toHaveProperty("emoji");
    for (const field of ["pollId", "eventName", "ballotLabel", "unrelatedLabel", "presentation"]) {
      expect(single.schema.properties).not.toHaveProperty(field);
    }
    const bindings: OpenClawConfig["bindings"] = [
      { agentId: "main", match: { channel: "qa-secondary", accountId: "*" } },
      { agentId: "other", match: { channel: "qa-unrelated" } },
    ];
    const multi = await discoverBindings(bindings);
    expect(multi.actions).toEqual(["poll", "react", "send"]);
    expect(multi.schema.properties).toHaveProperty("ballotLabel");
    expect(multi.schema.properties).toHaveProperty("presentation");
    expect(multi.schema.properties).not.toHaveProperty("eventName");
    expect(multi.schema.properties).not.toHaveProperty("unrelatedLabel");
    expect(
      JSON.stringify(await discoverBindings(bindings.toReversed(), channels.toReversed())),
    ).toBe(JSON.stringify(multi));
  });

  it("falls back to the normalized allowlist when no discovered action matches", () => {
    const result = discover({
      cfg: { tools: { message: { actions: { allow: ["read", "edit", "read"] } } } },
      currentChannelProvider: "telegram",
      preparedMessageToolCatalog: catalog([channel("telegram", ["send", "react"])]),
    });
    expect(result.schema.properties.action).toMatchObject({ enum: ["edit", "read"] });
    expect(result.description).not.toContain("react");
  });
});

describe("message tool discovery without a current channel", () => {
  it.each([
    { allow: undefined, actions: ["broadcast", "send"], compact: true },
    { allow: ["broadcast"], actions: ["broadcast"], compact: true },
    { allow: ["send", "react"], actions: ["react", "send"], compact: false },
  ])("keeps the fields needed by $actions", ({ allow, actions, compact }) => {
    const deliveryTag = Type.Optional(Type.String());
    const {
      actions: discovered,
      schema,
      properties,
    } = discover({
      cfg: { tools: { message: { actions: { allow } } } },
      preparedMessageToolCatalog: catalog([
        channel("telegram", compact ? ["send"] : ["send", "react"], { deliveryTag }, [
          "presentation",
          "delivery-pin",
        ]),
      ]),
    });

    expect(discovered).toEqual(actions);
    for (const field of ["target", "targets", "media", "attachments", "presentation", "delivery"]) {
      expect(properties).toHaveProperty(field);
    }
    expect(properties.deliveryTag).toEqual(deliveryTag);
    expect(Object.hasOwn(properties, "messageId")).toBe(!compact);
    for (const field of ["pollId", "eventName", "deleteDays", "activityState"]) {
      expect(properties).not.toHaveProperty(field);
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
    bindings: [
      { agentId: "main", match: { channel: "slack" } },
      { agentId: "main", match: { channel: "telegram" } },
    ],
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
    const plugins = [
      {
        ...createChannelTestPluginBase({ id: "slack" }),
        actions: expectDefined(
          resolveBundledChannelMessageToolDiscoveryAdapter("slack"),
          "Slack public message-tool discovery adapter",
        ),
      },
    ];
    if (foreignContexts) {
      plugins.push({
        ...createChannelTestPluginBase({ id: "telegram" }),
        actions: {
          describeMessageTool: (context) => {
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
      });
    }
    const registry = createTestRegistry(
      plugins.map((plugin) => ({ pluginId: plugin.id, source: "test", plugin })),
    );
    setActivePluginRegistry(registry);
    return expectDefined(settlePreparedMessageToolCatalog(registry), "prepared message catalog");
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
        isScheduledRun: true,
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
      const preparedCatalog = registerChannels(foreignContexts);
      const params: MessageToolDiscoveryParams = {
        cfg,
        agentId: "main",
        currentChannelProvider,
        currentAccountId: "disabled",
        currentChannelId: "delivery-room",
        currentChatType: "channel",
        currentThreadTs: "delivery-thread",
        currentMessageId: "delivery-message",
        sessionKey: "agent:main:cron:scheduled-read",
        sessionId: "scheduled-session",
        ...(prepared ? { preparedMessageToolCatalog: preparedCatalog } : {}),
      };
      const baseline = discover(params);
      const baselineContexts = foreignContexts.splice(0);
      const scoped = discover({
        ...params,
        isScheduledRun: true,
        scheduledAccountScope: { channels: ["slack"], accountId: "ops" },
      });

      expect(scoped.actions).toContain("read");
      expect(baseline.actions).not.toContain("read");
      expect(scoped.actions).toContain("poll");
      expect(baseline.properties).toHaveProperty("foreignHint");
      expect(scoped.properties.foreignHint).toEqual(baseline.properties.foreignHint);
      expect(foreignContexts.filter((context) => context.sessionKey)).toEqual(
        baselineContexts.filter((context) => context.sessionKey),
      );
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
