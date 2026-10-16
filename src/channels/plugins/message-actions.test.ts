import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
const emptyRegistry = createTestRegistry([]);
const handleAction = vi.fn(async (_ctx: ChannelMessageActionContext) => jsonResult({ ok: true }));
const supportsAction = vi.fn(() => true);
const requiresTrustedRequesterSender = vi.fn(() => false);

function activate(...plugins: ChannelPlugin[]) {
  setActivePluginRegistry(
    createTestRegistry(plugins.map((plugin) => ({ pluginId: plugin.id, source: "test", plugin }))),
  );
}

function register({
  channel = "discord",
  origin,
  messaging,
  actions,
}: {
  channel?: ChannelPlugin["id"];
  origin?: "bundled" | "workspace";
  messaging?: ChannelPlugin["messaging"];
  actions?: Partial<Actions>;
} = {}) {
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

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => {
  setActivePluginRegistry(emptyRegistry);
  vi.restoreAllMocks();
});

describe("message action authorization", () => {
  it.each([undefined, "trusted-user"])(
    "requires a trusted sender for moderation (sender=%s)",
    async (requesterSenderId) => {
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
        requesterSenderId,
      });
      if (requesterSenderId) {
        await pending;
        expect(handleAction).toHaveBeenCalledOnce();
      } else {
        await expect(pending).rejects.toThrow(
          "Trusted sender identity is required for discord:kick",
        );
        expect(handleAction).not.toHaveBeenCalled();
      }
    },
  );

  it.each([
    { name: "normalized current conversation", context: {}, allowed: true },
    { name: "missing requester", context: { requesterAccountId: undefined }, allowed: false },
    { name: "invalid account", context: { accountId: "!!!" }, allowed: false },
    {
      name: "forged provenance",
      context: {
        conversationReadOrigin: undefined,
        params: {
          channelId: "other",
          conversationReadOrigin: "direct-operator",
          pluginOrigin: "bundled",
          channelData: { conversationReadOrigin: "direct-operator", pluginOrigin: "bundled" },
        },
      },
      allowed: false,
    },
  ] satisfies { name: string; context: Partial<DispatchContext>; allowed: boolean }[])(
    "checks host context for $name",
    async ({ context, allowed }) => {
      register();
      if (allowed) {
        await dispatch(context);
        expect(handleAction).toHaveBeenCalledOnce();
      } else {
        await expectDenied(context);
      }
    },
  );

  it("rejects unknown runtime actions before plugin callbacks", async () => {
    register();
    expect(
      await dispatch({ action: "forged-read", conversationReadOrigin: "direct-operator" }),
    ).toBeNull();
    expect(handleAction).not.toHaveBeenCalled();
    expect(supportsAction).not.toHaveBeenCalled();
    expect(requiresTrustedRequesterSender).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "conflicting trusted kinds",
      params: { target: "current" },
      toolContext: {
        currentChannelProvider: "discord",
        currentChannelId: "channel:current",
        currentMessagingTarget: "user:current",
      },
    },
    {
      name: "bare trusted sibling hiding a kind mismatch",
      params: { target: "channel:current", channelId: "current" },
      toolContext: {
        currentChannelProvider: "discord",
        currentChannelId: "current",
        currentMessagingTarget: "user:current",
      },
    },
    {
      name: "provider prefix hiding a user kind",
      params: { target: "user:current", to: "nextcloud-talk:current" },
      toolContext: {
        currentChannelProvider: "nextcloud-talk",
        currentChannelId: "nextcloud-talk:current",
        currentChatType: "group",
      },
    },
    {
      name: "typed room without a canonical sibling",
      params: { target: "room:current" },
      toolContext: {
        currentChannelProvider: "nextcloud-talk",
        currentChannelId: "nextcloud-talk:current",
        currentChatType: "group",
      },
    },
    {
      name: "group target in a channel context",
      params: { target: "group:current", to: "nextcloud-talk:current" },
      toolContext: {
        currentChannelProvider: "nextcloud-talk",
        currentChannelId: "nextcloud-talk:current",
        currentChatType: "channel",
      },
    },
  ] satisfies {
    name: string;
    params: Record<string, unknown>;
    toolContext: DispatchContext["toolContext"];
  }[])("rejects $name", async ({ name: _name, params, toolContext }) => {
    const channel = toolContext?.currentChannelProvider ?? "discord";
    register({
      channel,
      origin: "workspace",
      messaging: { targetPrefixes: ["nextcloud-talk", "nc", "user"] },
    });
    await expectDenied({ channel, params, toolContext });
  });

  it.each([
    {
      name: "case-sensitive mismatch",
      target: "room:CURRENT",
      current: "nextcloud-talk:current",
      normalized: "nextcloud-talk:current",
      expected: undefined,
      origin: "delegated",
    },
    {
      name: "direct operator",
      target: "room:other",
      current: "nextcloud-talk:current",
      normalized: undefined,
      expected: "room:other",
      origin: "direct-operator",
    },
    {
      name: "normalization mirror",
      target: "room:current",
      current: "nc:current",
      normalized: "nextcloud-talk:other",
      expected: "nc:current",
      origin: "delegated",
    },
  ] as const)(
    "uses host target authority for $name",
    async ({ target, current, normalized, expected, origin }) => {
      const normalizeTarget = vi.fn(() => normalized);
      register({
        channel: "nextcloud-talk",
        origin: "workspace",
        messaging: {
          targetPrefixes: ["nc"],
          ...(normalized ? { normalizeTarget } : {}),
        },
      });
      const context: Partial<DispatchContext> = {
        channel: "nextcloud-talk",
        conversationReadOrigin: origin,
        params: { target, to: target },
        toolContext: {
          currentChannelProvider: "nextcloud-talk",
          currentChannelId: current,
          currentChatType: "group",
        },
      };
      if (expected === undefined) {
        await expectDenied(context);
      } else {
        await dispatch(context);
        expect(handleAction).toHaveBeenCalledOnce();
        expect(handleAction.mock.calls[0]?.[0].params).toEqual({ target: expected, to: expected });
      }
      expect(normalizeTarget).not.toHaveBeenCalled();
    },
  );

  it.each([
    { origin: "bundled", providerOwnedReadGates: true, allowed: true },
    { origin: "bundled", providerOwnedReadGates: ["read"], allowed: true },
    { origin: "workspace", providerOwnedReadGates: true, allowed: false },
  ] satisfies {
    origin: "bundled" | "workspace";
    providerOwnedReadGates: Actions["providerOwnedReadGates"];
    allowed: boolean;
  }[])(
    "delegates declared read gates only to bundled plugins (%j)",
    async ({ origin, providerOwnedReadGates, allowed }) => {
      register({ origin, actions: { providerOwnedReadGates } });
      const context = { params: { channelId: "configured" }, toolContext: undefined };
      if (allowed) {
        await dispatch(context);
        expect(handleAction).toHaveBeenCalledOnce();
      } else {
        await expectDenied(context);
      }
    },
  );
});

const aliasContext: Partial<DispatchContext> = {
  channel: "imessage",
  action: "react",
  params: { chatId: 42, messageId: "current-message" },
  toolContext: {
    currentChannelProvider: "imessage",
    currentChannelId: "current-handle",
    currentMessageId: "current-message",
  },
};

function registerAlias({
  origin = "bundled",
  ...matchers
}: {
  origin?: "bundled" | "workspace";
  matchesCurrentConversation?: () => boolean;
  matchesCurrentConversationAsync?: () => Promise<boolean>;
} = {}) {
  const resolveDeliveryTarget = vi.fn(
    ({ args }: { args: Record<string, unknown> }) => `chat_id:${String(args.chatId)}`,
  );
  register({
    channel: "imessage",
    origin,
    actions: {
      messageActionTargetAliases: {
        react: {
          aliases: ["chatId", "messageId"],
          deliveryTargetAliases: ["chatId"],
          resolveDeliveryTarget,
          ...matchers,
        },
      },
    },
  });
  return resolveDeliveryTarget;
}

function prepareAsyncAlias(origin: "bundled" | "workspace" = "bundled") {
  const proof = createDeferred<boolean>();
  const matchesCurrentConversation = vi.fn(() => true);
  const matchesCurrentConversationAsync = vi.fn(() => proof.promise);
  const resolveDeliveryTarget = registerAlias({
    origin,
    matchesCurrentConversation,
    matchesCurrentConversationAsync,
  });
  return {
    proof,
    resolveDeliveryTarget,
    matchesCurrentConversation,
    matchesCurrentConversationAsync,
  };
}

describe("message action delivery alias authority", () => {
  it("matches numeric delivery aliases through the bundled provider normalizer", async () => {
    const resolveDeliveryTarget = vi.fn(({ args }: { args: Record<string, unknown> }) =>
      typeof args.chatId === "number" && Number.isInteger(args.chatId) && args.chatId > 0
        ? `chat_id:${args.chatId}`
        : undefined,
    );
    register({
      channel: "imessage",
      origin: "bundled",
      messaging: { normalizeTarget: (raw) => raw.trim().toLowerCase() || undefined },
      actions: {
        messageActionTargetAliases: {
          react: {
            aliases: ["chatId", "messageId"],
            deliveryTargetAliases: ["chatId"],
            resolveDeliveryTarget,
          },
        },
      },
    });
    await dispatch({
      ...aliasContext,
      toolContext: { currentChannelProvider: "imessage", currentChannelId: "CHAT_ID:42" },
    });
    expect(resolveDeliveryTarget).toHaveBeenCalledOnce();
    expect(handleAction).toHaveBeenCalledOnce();
  });

  it.each([true, false])(
    "honors synchronous alias proof with normalized mirrors (proof=%s)",
    async (matches) => {
      const matchesCurrentConversation = vi.fn(() => matches);
      registerAlias({ matchesCurrentConversation });
      const context = {
        ...aliasContext,
        params: { ...aliasContext.params, target: "chat_id:42", to: "chat_id:42" },
      };
      if (matches) {
        await dispatch(context);
        expect(handleAction).toHaveBeenCalledOnce();
      } else {
        await expectDenied(context);
      }
      expect(matchesCurrentConversation).toHaveBeenCalledWith({
        args: context.params,
        accountId: "work",
        toolContext: aliasContext.toolContext,
      });
    },
  );

  it.each([true, false, "error"] as const)(
    "awaits async alias proof without legacy fallback (result=%s)",
    async (outcome) => {
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
    },
  );

  it.each(["external", "account", "provider", "sibling"] as const)(
    "rejects %s mismatch before alias callbacks",
    async (mismatch) => {
      const fixture = prepareAsyncAlias(mismatch === "external" ? "workspace" : "bundled");
      await expectDenied({
        ...aliasContext,
        ...(mismatch === "external" ? { params: { messageId: "current-message" } } : {}),
        ...(mismatch === "account" ? { accountId: undefined } : {}),
        ...(mismatch === "provider"
          ? { toolContext: { ...aliasContext.toolContext, currentChannelProvider: "discord" } }
          : {}),
        ...(mismatch === "sibling"
          ? { params: { ...aliasContext.params, target: "other-handle" } }
          : {}),
      });
      expect(fixture.matchesCurrentConversationAsync).not.toHaveBeenCalled();
      expect(fixture.matchesCurrentConversation).not.toHaveBeenCalled();
      if (mismatch !== "sibling") {
        expect(fixture.resolveDeliveryTarget).not.toHaveBeenCalled();
      }
    },
  );

  it.each(["caller", "registration"] as const)(
    "rechecks %s authority after awaited alias proof",
    async (revoked) => {
      const fixture = prepareAsyncAlias();
      const bundledFallback = vi
        .spyOn(bundled, "getBundledChannelPlugin")
        .mockReturnValue(undefined);
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
    },
  );

  it.each([
    {
      name: "delivery alias",
      aliases: {
        read: {
          aliases: ["chatGuid"],
          deliveryTargetAliases: ["chatGuid"],
          resolveDeliveryTarget: ({ args }) =>
            typeof args.chatGuid === "string" ? `chat_guid:${args.chatGuid}` : undefined,
        },
      },
      params: { to: "chat_guid:iMessage;+;current", chatGuid: "iMessage;+;other" },
    },
    {
      name: "canonical target",
      aliases: { read: { aliases: ["messageId"] } },
      params: {
        target: "malformed-target",
        to: "chat_guid:iMessage;+;current",
        messageId: "current-message",
      },
    },
  ] satisfies {
    name: string;
    aliases: Actions["messageActionTargetAliases"];
    params: Record<string, unknown>;
  }[])("rejects an unnormalizable $name even with a valid sibling", async ({ aliases, params }) => {
    register({
      channel: "imessage",
      origin: "bundled",
      messaging: { normalizeTarget: (raw) => (raw.includes("current") ? raw : undefined) },
      actions: { messageActionTargetAliases: aliases },
    });
    await expectDenied({
      channel: "imessage",
      params,
      toolContext: {
        currentChannelProvider: "imessage",
        currentChannelId: "chat_guid:iMessage;+;current",
      },
    });
  });

  it("does not grant resource-only mutations authority from a read-only provider gate", async () => {
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
});

describe("bundled targetless cache reads", () => {
  const context: Partial<DispatchContext> = {
    channel: "telegram",
    action: "sticker-search",
    params: { query: "party", limit: 5 },
    toolContext: { currentChannelProvider: "telegram", currentChannelId: "123" },
  };
  beforeEach(() => {
    register({ channel: "telegram", origin: "bundled" });
  });

  it.each([
    { name: "matching context", override: {}, allowed: true },
    {
      name: "missing provider",
      override: { toolContext: { currentChannelId: "123" } },
      allowed: false,
    },
    { name: "wrong account", override: { accountId: "other" }, allowed: false },
    {
      name: "missing current target",
      override: { toolContext: { currentChannelProvider: "telegram" } },
      allowed: false,
    },
  ] satisfies { name: string; override: Partial<DispatchContext>; allowed: boolean }[])(
    "checks cache-read authority with $name",
    async ({ override, allowed }) => {
      if (allowed) {
        await dispatch({ ...context, ...override });
        expect(handleAction).toHaveBeenCalledOnce();
      } else {
        await expectDenied({ ...context, ...override });
      }
    },
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

describe("message action discovery", () => {
  it.each([
    { name: "all plugins", channel: undefined, presentation: true, pin: true },
    {
      name: "channel alias",
      channel: "demo-cards-alias",
      presentation: false,
      pin: true,
    },
    { name: "missing channel", channel: "demo-missing", presentation: false, pin: false },
  ])("scopes capability fields to $name", async ({ channel, presentation, pin }) => {
    activateCapabilities();
    const { schema } = await resolveMessageToolDiscoveryAsync({
      cfg: {},
      currentChannelProvider: channel,
    });
    expect(Object.hasOwn(schema.properties, "presentation")).toBe(presentation);
    expect(Object.hasOwn(schema.properties, "delivery")).toBe(pin);
  });

  it("does not replace an explicitly empty prepared catalog", async () => {
    activateCapabilities();
    const preparedMessageToolCatalog = { version: 0, channels: [], getChannel: () => undefined };
    const { schema } = await resolveMessageToolDiscoveryAsync({
      cfg: {},
      preparedMessageToolCatalog,
    });
    expect(schema.properties).not.toHaveProperty("presentation");
    expect(schema.properties).not.toHaveProperty("delivery");
    expect(
      await runMessageActionDiscoveryAsync(
        resolveChannelMessageToolSchemaPropertiesSteps({
          cfg: {},
          channel: "demo-buttons",
          preparedMessageToolCatalog,
        }),
      ),
    ).toEqual({});
  });

  it("evaluates prepared discovery against each account context", async () => {
    const plugin = discoveryPlugin("demo-account-scoped", ({ accountId }) => ({
      actions: ["send"],
      capabilities: accountId === "first" ? ["presentation"] : ["delivery-pin"],
    }));
    activate(plugin);
    const preparedMessageToolCatalog = getPreparedMessageToolCatalog();
    const first = await resolveMessageToolDiscoveryAsync({
      cfg: {},
      currentChannelProvider: plugin.id,
      currentAccountId: "first",
      preparedMessageToolCatalog,
    });
    const second = await resolveMessageToolDiscoveryAsync({
      cfg: {},
      currentChannelProvider: plugin.id,
      currentAccountId: "second",
      preparedMessageToolCatalog,
    });
    expect(first.schema.properties).toHaveProperty("presentation");
    expect(second.schema.properties).not.toHaveProperty("presentation");
    expect(second.schema.properties).toHaveProperty("delivery");
  });

  it("keeps all-configured schema account-neutral from another current channel", async () => {
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
        accountId
          ? { actions: [], schema: null }
          : {
              actions: ["react", "send"],
              schema,
            },
      ),
      discoveryPlugin("slack", () => ({ actions: [] })),
    );
    const properties = await runMessageActionDiscoveryAsync(
      resolveChannelMessageToolSchemaPropertiesSteps({
        cfg: {},
        channel: "slack",
        accountId: "slack-workspace",
      }),
    );
    expect(properties).toHaveProperty("components");
    expect(properties).not.toHaveProperty("emoji");
  });

  it("keeps required and serialized contributed properties optional", async () => {
    activate(
      discoveryPlugin("demo-contrib", () => ({
        actions: ["send"],
        schema: {
          properties: {
            components: Type.Array(Type.String()),
            // Serialization loses TypeBox's non-enumerable optional marker.
            chatRef: structuredClone(Type.Optional(Type.String())),
            media: Type.Optional(Type.String()),
          },
        },
      })),
    );
    const properties = await runMessageActionDiscoveryAsync(
      resolveChannelMessageToolSchemaPropertiesSteps({
        cfg: {},
        channel: "demo-contrib",
      }),
    );
    expect(Type.Object({ action: Type.String(), ...properties }).required).toEqual(["action"]);
  });

  it.each([
    {
      name: "action-scoped",
      actions: ["read", "list-pins", "unpin"],
      scope: { actions: ["unpin"] },
      expected: ["read", "list-pins"],
    },
    { name: "unscoped", actions: ["read", "unpin"], scope: {}, expected: [] },
  ] satisfies {
    name: string;
    actions: NonNullable<ReturnType<Actions["describeMessageTool"]>>["actions"];
    scope: Pick<ChannelMessageToolSchemaContribution, "actions">;
    expected: string[];
  }[])(
    "filters cross-channel actions for $name current-channel schema",
    async ({ actions, scope, expected }) => {
      activate(
        discoveryPlugin("demo-scoped-schema", () => ({
          actions,
          schema: { ...scope, properties: { pinnedMessageId: Type.Optional(Type.String()) } },
        })),
      );
      expect(
        await runMessageActionDiscoveryAsync(
          listCrossChannelSchemaSupportedMessageActionsSteps({
            cfg: {},
            channel: "demo-scoped-schema",
          }),
        ),
      ).toStrictEqual(expected);
    },
  );

  it.each([
    {
      name: "action-scoped",
      mediaSourceParams: { "set-profile": ["avatarUrl", "avatarPath"] },
      sendParams: [],
    },
    {
      name: "flat",
      mediaSourceParams: ["avatarUrl", "avatarPath"],
      sendParams: ["avatarUrl", "avatarPath"],
    },
  ])("discovers $name media-source parameters", async ({ mediaSourceParams, sendParams }) => {
    activate(
      discoveryPlugin("demo-media", () => ({
        actions: ["send", "set-profile"],
        mediaSourceParams,
      })),
    );
    const paramsFor = (action: "send" | "set-profile") =>
      resolveChannelMessageToolMediaSourceParamKeysAsync({
        cfg: {},
        action,
        channel: "demo-media",
      });
    expect(await paramsFor("set-profile")).toEqual(["avatarUrl", "avatarPath"]);
    expect(await paramsFor("send")).toStrictEqual(sendParams);
  });

  it("skips crashing discovery and logs once", async () => {
    const errorSpy = vi.spyOn(defaultRuntime, "error").mockImplementation(() => undefined);
    activate(
      discoveryPlugin("demo-crashing", () => {
        throw new Error("boom");
      }),
    );
    expect(
      (await resolveMessageToolDiscoveryAsync({ cfg: {} })).schema.properties,
    ).not.toHaveProperty("presentation");
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(
      (await resolveMessageToolDiscoveryAsync({ cfg: {} })).schema.properties,
    ).not.toHaveProperty("presentation");
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });
});
