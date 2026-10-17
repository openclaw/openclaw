import { expectDefined } from "@openclaw/normalization-core";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const [readDeliveryMock, getChannelPluginMock, getBootstrapChannelPluginMock] = vi.hoisted(
  () => [vi.fn(), vi.fn(), vi.fn()] as const,
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
  ChannelPlugin,
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
  resolveMessageToolActionSchemaActions,
  resolveEffectiveCurrentChannelContextForRequest,
  resolveMessageToolDiscoveryAsync,
  type MessageToolDiscoveryParams,
} from "./message-tool-discovery.js";

const canonicalSpace = "spaces/AAQA1bC2dEf";
const foldedSpace = "spaces/aaqa1bc2def";
const accountDelivery = (accountId = "default", to = canonicalSpace) => ({
  channel: "googlechat",
  to,
  accountId,
});
const canonicalDelivery = accountDelivery("default", `googlechat:${canonicalSpace}`);
const options = {
  currentChannelProvider: "webchat",
  agentSessionKey: `agent:main:googlechat:group:${foldedSpace}`,
};
const request = { config: {}, action: "send" as const, params: {} };
const bindingsFor = (...channels: string[]) =>
  channels.map((channel) => ({ agentId: "main", match: { channel } }));

function makeCatalog(channels: PreparedMessageToolCatalog["channels"]): PreparedMessageToolCatalog {
  return { version: 1, channels, getChannel: (id) => channels.find((entry) => entry.id === id) };
}

function discoveryChannel(
  id: string,
  actions: ChannelMessageToolDiscovery["actions"],
  fields?: string[],
  capabilities?: ChannelMessageToolDiscovery["capabilities"],
): PreparedMessageToolCatalog["channels"][number] {
  const schema: ChannelMessageToolDiscovery["schema"] = fields && {
    visibility: "all-configured",
    properties: Object.fromEntries(fields.map((field) => [field, Type.Optional(Type.String())])),
  };
  const describeMessageTool = () => ({ actions, capabilities, schema });
  return { id, reconcilesUnknownSend: false, actions: { describeMessageTool } };
}

function discover(params: MessageToolDiscoveryParams) {
  const actions = resolveMessageToolActionSchemaActions(params);
  const schema = buildMessageToolSchema(params, actions);
  return {
    actions,
    schema,
    properties: schema.properties,
    description: buildMessageToolDescription(actions),
  };
}

function expectAccepts(schema: Parameters<typeof Value.Check>[0], payload: unknown, valid = true) {
  expect(Value.Check(schema, payload)).toBe(valid);
}

describe("session-derived message destinations", () => {
  beforeEach(() => {
    getBootstrapChannelPluginMock.mockReset();
    readDeliveryMock.mockReset().mockReturnValue(canonicalDelivery);
    getChannelPluginMock.mockReset().mockReturnValue({
      config: { listAccountIds: () => ["default"] },
      messaging: { targetIdComparison: "case-sensitive" },
    });
  });

  it.each([
    ["canonical group", canonicalDelivery, false, canonicalSpace],
    ["missing delivery", undefined, false, foldedSpace],
    ["another channel", { channel: "slack", to: canonicalSpace }, false, foldedSpace],
    ["another peer", { channel: "googlechat", to: "spaces/Other" }, false, foldedSpace],
    ["another account", accountDelivery("other"), false, foldedSpace],
    ["direct account and thread", accountDelivery("work"), true, canonicalSpace],
  ] as const)("recovers matching routes: %s", async (_name, delivery, direct, expected) => {
    readDeliveryMock.mockReturnValue(delivery);
    const agentSessionKey = direct
      ? `agent:main:googlechat:work:direct:${foldedSpace}:thread:Thread1`
      : options.agentSessionKey;
    const result = await resolveEffectiveCurrentChannelContextForRequest(
      { ...options, agentSessionKey },
      direct ? { ...request, accountId: "work" } : request,
    );
    expect(result).toEqual({
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
  ])("uses $name for destination recovery", async ({ selected, hasAliases, expected }) => {
    const messageActionTargetAliases = { read: { aliases: ["messageId"] } };
    const actions = {
      describeMessageTool: () => ({ actions: ["read"] as const }),
      messageActionTargetAliases,
    };
    getBootstrapChannelPluginMock.mockReturnValue({ actions: { messageActionTargetAliases } });
    const catalog = makeCatalog(
      hasAliases ? [{ id: "googlechat", reconcilesUnknownSend: false, actions }] : [],
    );
    const result = await resolveEffectiveCurrentChannelContextForRequest(options, {
      ...request,
      action: "read",
      params: { messageId: "message-1" },
      preparedMessageToolCatalog: selected ? catalog : undefined,
    });
    expect(result.currentMessagingTarget).toBe(expected);
    if (selected) {
      expect(getBootstrapChannelPluginMock).not.toHaveBeenCalled();
    }
  });

  it.each<[string, Record<string, unknown>, ("discovery" | "lowercase" | "inbound")?]>([
    ["explicit target", { target: "spaces/Explicit" }],
    ["explicit to", { to: "spaces/Explicit" }],
    ["explicit channelId", { channelId: "spaces/Explicit" }],
    ["explicit targets", { targets: ["spaces/Explicit"] }],
    ["reusable discovery", {}, "discovery"],
    ["lowercase-canonical channel", {}, "lowercase"],
    ["normal inbound destination", {}, "inbound"],
  ])("avoids delivery reads for %s", async (_name, params, mode) => {
    if (mode === "lowercase") {
      getChannelPluginMock.mockReturnValue({ messaging: { targetIdComparison: "lowercase" } });
    }
    const result = await resolveEffectiveCurrentChannelContextForRequest(
      mode === "inbound"
        ? { ...options, currentChannelProvider: "googlechat", currentChannelId: canonicalSpace }
        : options,
      mode === "discovery" ? undefined : { ...request, params },
    );
    if (mode === "inbound") {
      expect(result.currentChannelId).toBe(canonicalSpace);
    } else if (mode !== "discovery") {
      expect(result.currentMessagingTarget).toBe(foldedSpace);
    }
    expect(readDeliveryMock).not.toHaveBeenCalled();
  });
});

describe("message tool discovery cache stability", () => {
  it("limits stable discovery to session channel bindings", async () => {
    const channels: PreparedMessageToolCatalog["channels"] = [
      discoveryChannel("qa-primary", ["send", "react"], ["primaryLabel"]),
      discoveryChannel("qa-secondary", ["send", "poll"], ["ballotLabel"], ["presentation"]),
      discoveryChannel("qa-unrelated", ["event-create"], ["unrelatedLabel"]),
    ];
    const discoverBound = (bindings: OpenClawConfig["bindings"], orderedChannels = channels) =>
      resolveMessageToolDiscoveryAsync({
        cfg: { bindings },
        agentId: "main",
        currentChannelProvider: "qa-primary",
        preparedMessageToolCatalog: makeCatalog(orderedChannels),
      });
    const single = await discoverBound([]);
    expect(single.actions).toEqual(["react", "send"]);
    expect(single.schema.properties).toHaveProperty("emoji");
    for (const field of ["pollId", "eventName", "ballotLabel", "unrelatedLabel", "presentation"]) {
      expect(single.schema.properties).not.toHaveProperty(field);
    }
    const bindings: OpenClawConfig["bindings"] = [
      { agentId: "main", match: { channel: "qa-secondary", accountId: "*" } },
      { agentId: "other", match: { channel: "qa-unrelated" } },
    ];
    const multi = await discoverBound(bindings);
    expect(multi.actions).toEqual(["poll", "react", "send"]);
    expect(multi.schema.properties).toHaveProperty("ballotLabel");
    expect(multi.schema.properties).toHaveProperty("presentation");
    expect(multi.schema.properties).not.toHaveProperty("eventName");
    expect(multi.schema.properties).not.toHaveProperty("unrelatedLabel");
    expectAccepts(multi.schema, {
      action: "poll",
      pollQuestion: "Ready?",
      pollOption: ["Yes", "No"],
    });
    const reversed = await discoverBound(bindings.toReversed(), channels.toReversed());
    expect(JSON.stringify(reversed)).toBe(JSON.stringify(multi));
  });

  it.each([
    { allow: undefined, expected: ["poll", "poll-vote", "react", "send"] },
    { allow: ["send", "react", "poll", "react"], expected: ["poll", "react", "send"] },
    { allow: ["read", "edit", "read"], expected: ["edit", "read"] },
  ])("keeps bytes stable across discovery order ($allow)", ({ allow, expected }) => {
    const channels: PreparedMessageToolCatalog["channels"] = [
      discoveryChannel("telegram", ["send", "react", "poll"]),
      discoveryChannel("discord", ["send", "poll", "poll-vote"]),
    ];
    const createTool = (orderedChannels = channels, currentChannelProvider = "telegram") =>
      discover({
        cfg: {
          tools: { message: { actions: { allow } } },
          bindings: bindingsFor("telegram", "discord"),
        },
        agentId: "main",
        currentChannelProvider,
        preparedMessageToolCatalog: makeCatalog(orderedChannels),
      });
    const tools = [createTool(), createTool(channels.toReversed(), "discord")] as const;
    expect(tools[0].description).toBe(tools[1].description);
    expect(JSON.stringify(tools[0].schema)).toBe(JSON.stringify(tools[1].schema));
    for (const tool of tools) {
      expect(tool.properties.action).toMatchObject({ enum: expected });
      if (allow) {
        expect(tool.description).not.toContain("poll-vote");
      }
    }
  });
});

it.each([
  { allow: undefined, actions: ["broadcast", "send"], compact: true },
  { allow: ["broadcast"], actions: ["broadcast"], compact: true },
  { allow: ["send", "react"], actions: ["react", "send"], compact: false },
])("keeps no-channel fields for $actions", ({ allow, actions, compact }) => {
  const deliveryTag = Type.Optional(Type.String());
  const channels: PreparedMessageToolCatalog["channels"] = [
    discoveryChannel(
      "telegram",
      compact ? ["send"] : ["send", "react"],
      ["deliveryTag"],
      ["presentation", "delivery-pin"],
    ),
  ];
  const result = discover({
    cfg: { tools: { message: { actions: { allow } } } },
    preparedMessageToolCatalog: makeCatalog(channels),
  });
  const { schema, properties } = result;
  expect(result.actions).toEqual(actions);
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
  expectAccepts(schema, payload);
  expectAccepts(schema, { ...payload, deliveryTag: 1 }, false);
});

describe("scheduled account discovery", () => {
  const accounts = {
    ops: { botToken: "xoxb-scheduled-discovery" },
    disabled: { enabled: false, botToken: "xoxb-disabled-discovery" },
  };
  const cfg: OpenClawConfig = {
    bindings: bindingsFor("slack", "telegram"),
    channels: { slack: { accounts } },
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
        "Slack discovery adapter",
      ),
    };
    const plugins: ChannelPlugin[] = [slack];
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
  ])("$origin uses $owner, not $delivery", ({ origin, owner, delivery, readable }) => {
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
    expectAccepts(
      result.schema,
      { action: "read", channel: "slack", target: "channel:C123", limit: 1 },
      readable,
    );
    expect(result.properties.topLevel !== undefined).toBe(readable);
    expect(result.properties.presentation !== undefined).toBe(readable);
    expect(result.description.includes("read")).toBe(readable);
  });

  it.each([
    [undefined, false],
    [undefined, true],
    ["slack", false],
    ["slack", true],
    ["telegram", false],
    ["telegram", true],
  ] as const)("foreign discovery: %s, prepared %s", (currentChannelProvider, prepared) => {
    const foreignContexts: ChannelMessageActionDiscoveryContext[] = [];
    const catalog = registerChannels(foreignContexts);
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
      ...(prepared ? { preparedMessageToolCatalog: catalog } : {}),
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
    expectAccepts(scoped.schema, {
      action: "send",
      channel: "telegram",
      target: "chat:delivery",
      message: "hello",
      foreignHint: "retained",
    });
  });
});
