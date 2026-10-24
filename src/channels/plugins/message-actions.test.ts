import { Type } from "typebox";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { jsonResult } from "../../agents/tools/common.js";
import { resolveMessageToolDiscoveryAsync } from "../../agents/tools/message-tool-discovery.js";
import { getPreparedMessageToolCatalog } from "../../plugins/prepared-message-tool-catalog.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { defaultRuntime } from "../../runtime.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";
import * as bundled from "./bundled.js";
import {
  listCrossChannelSchemaSupportedMessageActionsSteps,
  resolveChannelMessageToolMediaSourceParamKeysAsync,
  resolveChannelMessageToolSchemaPropertiesSteps,
  runMessageActionDiscoveryAsync,
} from "./message-action-discovery.js";
import { dispatchChannelMessageAction } from "./message-action-dispatch.js";
import type {
  ChannelMessageActionContext,
  ChannelMessageToolSchemaContribution,
  ChannelPlugin,
} from "./types.public.js";

type DispatchContext = Parameters<typeof dispatchChannelMessageAction>[0];
type Actions = NonNullable<ChannelPlugin["actions"]>;
type Alias = NonNullable<NonNullable<Actions["messageActionTargetAliases"]>["react"]>;
type TargetCase = [Record<string, unknown>, DispatchContext["toolContext"]];
type AccessCase = [string, Partial<DispatchContext>, boolean];
const nc = "nextcloud-talk";
const ncCurrent = `${nc}:current`;
const emptyRegistry = createTestRegistry([]);
const handleAction = vi.fn(async (_ctx: ChannelMessageActionContext) => jsonResult({ ok: true }));
const supportsAction = vi.fn(() => true);
const requiresTrustedRequesterSender = vi.fn(() => false);

function currentContext(
  currentChannelProvider: string,
  currentChannelId: string,
  extra: DispatchContext["toolContext"] = {},
) {
  return { currentChannelProvider, currentChannelId, ...extra };
}

async function expectAccess(context: Partial<DispatchContext>, allowed: boolean) {
  if (!allowed) {
    return expectDenied(context);
  }
  await dispatch(context);
  expect(handleAction).toHaveBeenCalledOnce();
}

const nextcloudContext = (
  id = ncCurrent,
  currentChatType: NonNullable<DispatchContext["toolContext"]>["currentChatType"] = "group",
) => currentContext(nc, id, { currentChatType });

async function discover(
  options: Omit<Parameters<typeof resolveMessageToolDiscoveryAsync>[0], "cfg"> = {},
) {
  return (await resolveMessageToolDiscoveryAsync({ cfg: {}, ...options })).schema.properties;
}

function schemaProperties(
  options: Omit<Parameters<typeof resolveChannelMessageToolSchemaPropertiesSteps>[0], "cfg">,
) {
  return runMessageActionDiscoveryAsync(
    resolveChannelMessageToolSchemaPropertiesSteps({ cfg: {}, ...options }),
  );
}

function activate(...plugins: ChannelPlugin[]) {
  setActivePluginRegistry(
    createTestRegistry(plugins.map((plugin) => ({ pluginId: plugin.id, source: "test", plugin }))),
  );
}

function register(
  options: {
    channel?: ChannelPlugin["id"];
    origin?: "bundled" | "workspace";
    messaging?: ChannelPlugin["messaging"];
    actions?: Partial<Actions>;
  } = {},
) {
  const { channel = "discord", origin, messaging, actions } = options;
  const plugin: ChannelPlugin = {
    ...createChannelTestPluginBase({
      id: channel,
      capabilities: { chatTypes: ["direct", "group"] },
    }),
    messaging,
    actions: {
      describeMessageTool: () => ({ actions: ["read", "send"] }),
      supportsAction,
      requiresTrustedRequesterSender,
      handleAction,
      ...actions,
    },
  };
  setActivePluginRegistry(
    createTestRegistry([{ pluginId: channel, source: "test", origin, plugin }]),
  );
}

function dispatch(overrides: Partial<DispatchContext> = {}) {
  return dispatchChannelMessageAction({
    cfg: {},
    channel: "discord",
    action: "read",
    params: { channelId: "channel:current" },
    accountId: "Work",
    requesterAccountId: "work",
    conversationReadOrigin: "delegated",
    toolContext: { currentChannelProvider: "discord", currentChannelId: "discord:channel:current" },
    ...overrides,
  });
}

async function expectDenied(overrides: Partial<DispatchContext>) {
  await expect(dispatch(overrides)).rejects.toThrow(
    "requires the exact current conversation and account",
  );
  expect(handleAction).not.toHaveBeenCalled();
  expect(supportsAction).not.toHaveBeenCalled();
  expect(requiresTrustedRequesterSender).not.toHaveBeenCalled();
}

beforeEach(() => vi.clearAllMocks());
afterEach(() => {
  setActivePluginRegistry(emptyRegistry);
  vi.restoreAllMocks();
});

it.each([undefined, "trusted-user"])("gates moderation sender: %s", async (sender) => {
  register({
    actions: {
      describeMessageTool: () => ({ actions: ["kick"] }),
      supportsAction: ({ action }) => action === "kick",
      requiresTrustedRequesterSender: ({ action, toolContext }) =>
        Boolean(action === "kick" && toolContext),
    },
  });
  const pending = dispatch({
    action: "kick",
    params: { guildId: "g1", userId: "u1" },
    requesterSenderId: sender,
  });
  if (sender) {
    await pending;
    expect(handleAction).toHaveBeenCalledOnce();
  } else {
    await expect(pending).rejects.toThrow("Trusted sender identity is required for discord:kick");
    expect(handleAction).not.toHaveBeenCalled();
  }
});

it.each<AccessCase>([
  ["normalized current conversation", {}, true],
  ["missing requester", { requesterAccountId: undefined }, false],
  ["invalid account", { accountId: "!!!" }, false],
  [
    "forged provenance",
    {
      conversationReadOrigin: undefined,
      params: {
        channelId: "other",
        conversationReadOrigin: "direct-operator",
        pluginOrigin: "bundled",
        channelData: { conversationReadOrigin: "direct-operator", pluginOrigin: "bundled" },
      },
    },
    false,
  ],
])("checks host context: %s", async (_name, context, allowed) => {
  register();
  await expectAccess(context, allowed);
});

it.each(["forged-read", "toString", "constructor", "__proto__"])(
  "rejects unknown action %s before callbacks",
  async (action) => {
    register();
    const params = { target: "channel:C1" };
    expect(
      await dispatch({ action, params, conversationReadOrigin: "direct-operator" }),
    ).toBeNull();
    expect(params).toEqual({ target: "channel:C1" });
    expect(handleAction).not.toHaveBeenCalled();
    expect(supportsAction).not.toHaveBeenCalled();
    expect(requiresTrustedRequesterSender).not.toHaveBeenCalled();
  },
);

it.each<TargetCase>([
  [
    { target: "current" },
    currentContext("discord", "channel:current", {
      currentMessagingTarget: "user:current",
    }),
  ],
  [
    { target: "channel:current", channelId: "current" },
    currentContext("discord", "current", { currentMessagingTarget: "user:current" }),
  ],
  [{ target: "user:current", to: ncCurrent }, nextcloudContext()],
  [{ target: "room:current" }, nextcloudContext()],
  [{ target: "group:current", to: ncCurrent }, nextcloudContext(undefined, "channel")],
])("rejects conflicting target kinds: %j", async (params, toolContext) => {
  const channel = toolContext?.currentChannelProvider ?? "discord";
  register({
    channel,
    origin: "workspace",
    messaging: { targetPrefixes: [nc, "nc", "user"] },
  });
  await expectDenied({ channel, params, toolContext });
});

it.each([
  ["room:CURRENT", ncCurrent, ncCurrent, undefined, "delegated"],
  ["room:other", ncCurrent, undefined, "room:other", "direct-operator"],
  ["room:current", "nc:current", `${nc}:other`, "nc:current", "delegated"],
] as const)("authorizes host target: %s", async (target, current, normalized, expected, origin) => {
  const normalizeTarget = vi.fn(() => normalized);
  register({
    channel: nc,
    origin: "workspace",
    messaging: {
      targetPrefixes: ["nc"],
      ...(normalized ? { normalizeTarget } : {}),
    },
  });
  const context: Partial<DispatchContext> = {
    channel: nc,
    conversationReadOrigin: origin,
    params: { target, to: target },
    toolContext: nextcloudContext(current),
  };
  if (expected === undefined) {
    await expectDenied(context);
  } else {
    await expectAccess(context, true);
    expect(handleAction.mock.calls[0]?.[0].params).toEqual({ target: expected, to: expected });
  }
  expect(normalizeTarget).not.toHaveBeenCalled();
});

it.each<["bundled" | "workspace", Actions["providerOwnedReadGates"], boolean]>([
  ["bundled", true, true],
  ["bundled", ["read"], true],
  ["workspace", true, false],
])("trusts bundled read gates: %j", async (origin, providerOwnedReadGates, allowed) => {
  register({ origin, actions: { providerOwnedReadGates } });
  await expectAccess({ params: { channelId: "configured" }, toolContext: undefined }, allowed);
});
const aliasContext: Partial<DispatchContext> = {
  channel: "imessage",
  action: "react",
  params: { chatId: 42, messageId: "current-message" },
  toolContext: currentContext("imessage", "current-handle", {
    currentMessageId: "current-message",
  }),
};

function registerAlias(
  alias: Partial<Alias> = {},
  origin: "bundled" | "workspace" = "bundled",
  messaging?: ChannelPlugin["messaging"],
) {
  const resolveDeliveryTarget = vi.fn(
    ({ args }: { args: Record<string, unknown> }) => `chat_id:${String(args.chatId)}`,
  );
  const react: Alias = {
    aliases: ["chatId", "messageId"],
    deliveryTargetAliases: ["chatId"],
    resolveDeliveryTarget,
    ...alias,
  };
  register({
    channel: "imessage",
    origin,
    messaging,
    actions: { messageActionTargetAliases: { react } },
  });
  return resolveDeliveryTarget;
}

function prepareAsyncAlias(origin: "bundled" | "workspace" = "bundled") {
  const proof = createDeferred<boolean>();
  const matchers = {
    matchesCurrentConversation: vi.fn(() => true),
    matchesCurrentConversationAsync: vi.fn(() => proof.promise),
  };
  return { proof, resolveDeliveryTarget: registerAlias(matchers, origin), ...matchers };
}

it("normalizes bundled numeric delivery aliases", async () => {
  const resolveDeliveryTarget = vi.fn(({ args }: { args: Record<string, unknown> }) =>
    typeof args.chatId === "number" && Number.isInteger(args.chatId) && args.chatId > 0
      ? `chat_id:${args.chatId}`
      : undefined,
  );
  registerAlias({ resolveDeliveryTarget }, "bundled", {
    normalizeTarget: (raw) => raw.trim().toLowerCase() || undefined,
  });
  await dispatch({
    ...aliasContext,
    toolContext: { currentChannelProvider: "imessage", currentChannelId: "CHAT_ID:42" },
  });
  expect(resolveDeliveryTarget).toHaveBeenCalledOnce();
  expect(handleAction).toHaveBeenCalledOnce();
});

it.each([true, false])("checks synchronous alias proof: %s", async (matches) => {
  const matchesCurrentConversation = vi.fn(() => matches);
  registerAlias({ matchesCurrentConversation });
  const context = {
    ...aliasContext,
    params: { ...aliasContext.params, target: "chat_id:42", to: "chat_id:42" },
  };
  await expectAccess(context, matches);
  expect(matchesCurrentConversation).toHaveBeenCalledWith({
    args: context.params,
    accountId: "work",
    toolContext: aliasContext.toolContext,
  });
});

it.each([true, false, "error"] as const)("awaits alias, never sync: %s", async (outcome) => {
  const fixture = prepareAsyncAlias();
  const pending = dispatch(aliasContext);
  expect(fixture.matchesCurrentConversationAsync).toHaveBeenCalledOnce();
  expect(handleAction).not.toHaveBeenCalled();
  const expected =
    outcome === true
      ? expect(pending).resolves.toMatchObject({ details: { ok: true } })
      : expect(pending).rejects.toThrow(
          outcome === "error" ? "proof unavailable" : "exact current conversation",
        );
  if (outcome === "error") {
    fixture.proof.reject(new Error("proof unavailable"));
  } else {
    fixture.proof.resolve(outcome);
  }
  await expected;
  expect(fixture.matchesCurrentConversation).not.toHaveBeenCalled();
  expect(handleAction).toHaveBeenCalledTimes(outcome === true ? 1 : 0);
});

it.each<[string, Partial<DispatchContext>]>([
  ["external", { params: { messageId: "current-message" } }],
  ["account", { accountId: undefined }],
  ["provider", { toolContext: { ...aliasContext.toolContext, currentChannelProvider: "discord" } }],
  ["sibling", { params: { ...aliasContext.params, target: "other-handle" } }],
])("rejects %s before alias callbacks", async (mismatch, context) => {
  const fixture = prepareAsyncAlias(mismatch === "external" ? "workspace" : "bundled");
  await expectDenied({ ...aliasContext, ...context });
  expect(fixture.matchesCurrentConversationAsync).not.toHaveBeenCalled();
  expect(fixture.matchesCurrentConversation).not.toHaveBeenCalled();
  if (mismatch !== "sibling") {
    expect(fixture.resolveDeliveryTarget).not.toHaveBeenCalled();
  }
});

it.each(["caller", "registration"] as const)("rechecks %s after alias proof", async (revoked) => {
  const fixture = prepareAsyncAlias();
  const bundledFallback = vi.spyOn(bundled, "getBundledChannelPlugin").mockReturnValue(undefined);
  let callerCurrent = true;
  const pending = dispatch({
    ...aliasContext,
    assertDirectAdapterHandoff: () => {
      if (!callerCurrent) {
        throw new Error("caller is no longer active");
      }
    },
  });
  const expected = expect(pending).rejects.toThrow("no longer active");
  if (revoked === "caller") {
    callerCurrent = false;
  } else {
    setActivePluginRegistry(emptyRegistry);
  }
  fixture.proof.resolve(true);
  await expected;
  expect(handleAction).not.toHaveBeenCalled();
  expect(bundledFallback).not.toHaveBeenCalled();
});

it.each([true, false])("rejects malformed target beside valid sibling: %s", async (delivery) => {
  const current = "chat_guid:iMessage;+;current";
  const alias: Alias = delivery
    ? {
        aliases: ["chatGuid"],
        deliveryTargetAliases: ["chatGuid"],
        resolveDeliveryTarget: ({ args }) =>
          typeof args.chatGuid === "string" ? `chat_guid:${args.chatGuid}` : undefined,
      }
    : { aliases: ["messageId"] };
  register({
    channel: "imessage",
    origin: "bundled",
    messaging: { normalizeTarget: (raw) => (raw.includes("current") ? raw : undefined) },
    actions: { messageActionTargetAliases: { read: alias } },
  });
  await expectDenied({
    channel: "imessage",
    params: {
      to: current,
      ...(delivery
        ? { chatGuid: "iMessage;+;other" }
        : { target: "malformed-target", messageId: "current-message" }),
    },
    toolContext: currentContext("imessage", current),
  });
});

it("denies resource-only mutations through a read-only gate", async () => {
  register({
    channel: "imessage",
    origin: "bundled",
    actions: {
      providerOwnedReadGates: ["read"],
      messageActionTargetAliases: { react: { aliases: ["messageId"] } },
    },
  });
  await expectDenied({ ...aliasContext, params: { messageId: "current-message" } });
});
it.each<AccessCase>([
  ["matching context", {}, true],
  ["missing provider", { toolContext: { currentChannelId: "123" } }, false],
  ["wrong account", { accountId: "other" }, false],
  ["missing current target", { toolContext: { currentChannelProvider: "telegram" } }, false],
])("checks bundled cache-read authority: %s", async (_name, override, allowed) => {
  register({ channel: "telegram", origin: "bundled" });
  await expectAccess(
    {
      channel: "telegram",
      action: "sticker-search",
      params: { query: "party", limit: 5 },
      toolContext: currentContext("telegram", "123"),
      ...override,
    },
    allowed,
  );
});

function discoveryPlugin(
  id: string,
  describeMessageTool: Actions["describeMessageTool"],
): ChannelPlugin {
  return {
    ...createChannelTestPluginBase({ id, capabilities: { chatTypes: ["direct", "group"] } }),
    actions: { describeMessageTool },
  };
}

function activateDiscovery(description: ReturnType<Actions["describeMessageTool"]>, id = "demo") {
  activate(discoveryPlugin(id, () => description));
}

function activateCapabilities() {
  const cards = discoveryPlugin("demo-cards", () => ({
    actions: ["send"],
    capabilities: ["delivery-pin"],
  }));
  cards.meta.aliases = ["demo-cards-alias"];
  activate(
    discoveryPlugin("demo-buttons", () => ({ actions: ["send"], capabilities: ["presentation"] })),
    cards,
  );
}

it.each<[string, boolean, boolean]>([
  ["demo-cards-alias", false, true],
  ["demo-missing", false, false],
])("scopes capabilities: %s", async (channel, presentation, pin) => {
  activateCapabilities();
  const properties = await discover({ currentChannelProvider: channel });
  expect([
    Object.hasOwn(properties, "presentation"),
    Object.hasOwn(properties, "delivery"),
  ]).toEqual([presentation, pin]);
});

it("preserves an explicitly empty prepared catalog", async () => {
  activateCapabilities();
  const preparedMessageToolCatalog = { version: 0, channels: [], getChannel: () => undefined };
  const properties = await discover({ preparedMessageToolCatalog });
  expect(properties).not.toHaveProperty("presentation");
  expect(properties).not.toHaveProperty("delivery");
  expect(await schemaProperties({ channel: "demo-buttons", preparedMessageToolCatalog })).toEqual(
    {},
  );
});

it("discovers per account from a prepared catalog", async () => {
  const plugin = discoveryPlugin("demo-account-scoped", ({ accountId }) => ({
    actions: ["send"],
    capabilities: accountId === "first" ? ["presentation"] : ["delivery-pin"],
  }));
  activate(plugin);
  const preparedMessageToolCatalog = getPreparedMessageToolCatalog();
  const forAccount = (currentAccountId: string) =>
    discover({
      currentChannelProvider: plugin.id,
      currentAccountId,
      preparedMessageToolCatalog,
    });
  expect(await forAccount("first")).toHaveProperty("presentation");
  const second = await forAccount("second");
  expect(second).not.toHaveProperty("presentation");
  expect(second).toHaveProperty("delivery");
});

it("keeps cross-channel schema account-neutral", async () => {
  const schema: ChannelMessageToolSchemaContribution[] = [
    { actions: ["react"], properties: { emoji: Type.Optional(Type.String()) } },
    {
      actions: ["send"],
      properties: { components: Type.Optional(Type.Object({})) },
      visibility: "all-configured",
    },
  ];
  activate(
    discoveryPlugin("discord", ({ accountId }) =>
      accountId ? { actions: [], schema: null } : { actions: ["react", "send"], schema },
    ),
    discoveryPlugin("slack", () => ({ actions: [] })),
  );
  const properties = await schemaProperties({ channel: "slack", accountId: "slack-workspace" });
  expect(properties).toHaveProperty("components");
  expect(properties).not.toHaveProperty("emoji");
});

it("makes required and serialized properties optional", async () => {
  activateDiscovery({
    actions: ["send"],
    schema: {
      properties: {
        components: Type.Array(Type.String()),
        // Serialization loses TypeBox's non-enumerable optional marker.
        chatRef: structuredClone(Type.Optional(Type.String())),
        media: Type.Optional(Type.String()),
      },
    },
  });
  const properties = await schemaProperties({ channel: "demo" });
  expect(Type.Object({ action: Type.String(), ...properties }).required).toEqual(["action"]);
});

it.each([true, false])("filters cross-channel schema actions: %s", async (scoped) => {
  activateDiscovery({
    actions: scoped ? ["read", "list-pins", "unpin"] : ["read", "unpin"],
    schema: {
      ...(scoped ? { actions: ["unpin"] } : {}),
      properties: { pinnedMessageId: Type.Optional(Type.String()) },
    },
  });
  expect(
    await runMessageActionDiscoveryAsync(
      listCrossChannelSchemaSupportedMessageActionsSteps({
        cfg: {},
        channel: "demo",
      }),
    ),
  ).toStrictEqual(scoped ? ["read", "list-pins"] : []);
});

it.each([true, false])("discovers media-source parameters: %s", async (scoped) => {
  const keys = ["avatarUrl", "avatarPath"];
  activateDiscovery({
    actions: ["send", "set-profile"],
    mediaSourceParams: scoped ? { "set-profile": keys } : keys,
  });
  const paramsFor = (action: "send" | "set-profile") =>
    resolveChannelMessageToolMediaSourceParamKeysAsync({
      cfg: {},
      action,
      channel: "demo",
    });
  expect(await paramsFor("set-profile")).toEqual(["avatarUrl", "avatarPath"]);
  expect(await paramsFor("send")).toStrictEqual(scoped ? [] : keys);
});

it("skips crashing discovery and logs once", async () => {
  const errorSpy = vi.spyOn(defaultRuntime, "error").mockImplementation(() => undefined);
  activate(
    discoveryPlugin("demo-crashing", () => {
      throw new Error("boom");
    }),
  );
  expect(await discover()).not.toHaveProperty("presentation");
  expect(errorSpy).toHaveBeenCalledTimes(1);
  expect(await discover()).not.toHaveProperty("presentation");
  expect(errorSpy).toHaveBeenCalledTimes(1);
});
