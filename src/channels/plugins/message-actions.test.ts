import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { jsonResult } from "../../agents/tools/common.js";
import { getPreparedMessageToolCatalog } from "../../plugins/prepared-message-tool-catalog.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { defaultRuntime } from "../../runtime.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";
import * as bundled from "./bundled.js";
import {
  channelSupportsMessageCapability,
  channelSupportsMessageCapabilityForChannel,
  listCrossChannelSchemaSupportedMessageActions,
  resolveChannelMessageToolMediaSourceParamKeys,
  resolveChannelMessageToolSchemaProperties,
} from "./message-action-discovery.js";
import { dispatchChannelMessageAction } from "./message-action-dispatch.js";
import type { ChannelMessageCapability } from "./message-capabilities.js";
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

  it("allows the exact current conversation with normalized account and provider prefixes", async () => {
    register();
    await dispatch();
    expect(handleAction).toHaveBeenCalledOnce();
  });

  it("ignores model-argument and channelData provenance spoofing when host origin is missing", async () => {
    register();
    await expectDenied({
      conversationReadOrigin: undefined,
      params: {
        channelId: "other",
        conversationReadOrigin: "direct-operator",
        pluginOrigin: "bundled",
        channelData: { conversationReadOrigin: "direct-operator", pluginOrigin: "bundled" },
      },
    });
  });

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
    { name: "missing requester", requesterAccountId: undefined },
    { name: "invalid account", accountId: "!!!" },
  ])("rejects $name account context", async ({ name: _name, ...context }) => {
    register();
    await expectDenied(context);
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

  it("does not let an external normalizer equate a different case-sensitive conversation", async () => {
    const normalizeTarget = vi.fn(() => "nextcloud-talk:current");
    register({
      channel: "nextcloud-talk",
      origin: "workspace",
      messaging: { normalizeTarget, targetPrefixes: ["nc"] },
    });
    await expectDenied({
      channel: "nextcloud-talk",
      params: { target: "room:CURRENT", to: "room:CURRENT" },
      toolContext: {
        currentChannelProvider: "nextcloud-talk",
        currentChannelId: "nextcloud-talk:current",
        currentChatType: "group",
      },
    });
    expect(normalizeTarget).not.toHaveBeenCalled();
  });

  it("preserves direct-operator targets instead of rewriting them from current context", async () => {
    register({
      channel: "nextcloud-talk",
      origin: "workspace",
      messaging: { targetPrefixes: ["nc"] },
    });
    await dispatch({
      channel: "nextcloud-talk",
      conversationReadOrigin: "direct-operator",
      params: { target: "room:other", to: "room:other" },
      toolContext: {
        currentChannelProvider: "nextcloud-talk",
        currentChannelId: "nextcloud-talk:current",
        currentChatType: "group",
      },
    });
    expect(handleAction).toHaveBeenCalledOnce();
    expect(handleAction.mock.calls[0]?.[0].params).toEqual({
      target: "room:other",
      to: "room:other",
    });
  });

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

  it("canonicalizes an external normalization mirror to the trusted current target", async () => {
    const normalizeTarget = vi.fn(() => "nextcloud-talk:other");
    register({
      channel: "nextcloud-talk",
      origin: "workspace",
      messaging: { targetPrefixes: ["nc"], normalizeTarget },
    });
    await dispatch({
      channel: "nextcloud-talk",
      params: { target: "room:current", to: "room:current" },
      toolContext: {
        currentChannelProvider: "nextcloud-talk",
        currentChannelId: "nc:current",
        currentChatType: "group",
      },
    });
    expect(handleAction).toHaveBeenCalledOnce();
    expect(handleAction.mock.calls[0]?.[0].params).toEqual({
      target: "nc:current",
      to: "nc:current",
    });
    expect(normalizeTarget).not.toHaveBeenCalled();
  });
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

  it("rejects an unnormalizable bundled delivery alias even with a valid sibling", async () => {
    register({
      channel: "imessage",
      origin: "bundled",
      messaging: { normalizeTarget: (raw) => (raw.includes("current") ? raw : undefined) },
      actions: {
        messageActionTargetAliases: {
          read: {
            aliases: ["chatGuid"],
            deliveryTargetAliases: ["chatGuid"],
            resolveDeliveryTarget: ({ args }) =>
              typeof args.chatGuid === "string" ? `chat_guid:${args.chatGuid}` : undefined,
          },
        },
      },
    });
    await expectDenied({
      channel: "imessage",
      params: { to: "chat_guid:iMessage;+;current", chatGuid: "iMessage;+;other" },
      toolContext: {
        currentChannelProvider: "imessage",
        currentChannelId: "chat_guid:iMessage;+;current",
      },
    });
  });

  it("does not let failed canonical normalization fall through as resource-only", async () => {
    register({
      channel: "imessage",
      origin: "bundled",
      messaging: { normalizeTarget: (raw) => (raw.includes("current") ? raw : undefined) },
      actions: { messageActionTargetAliases: { read: { aliases: ["messageId"] } } },
    });
    await expectDenied({
      channel: "imessage",
      params: {
        target: "malformed-target",
        to: "chat_guid:iMessage;+;current",
        messageId: "current-message",
      },
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

  it("allows a cache read in matching current context", async () => {
    await dispatch(context);
    expect(handleAction).toHaveBeenCalledOnce();
  });

  it.each([
    { name: "missing provider", toolContext: { currentChannelId: "123" } },
    { name: "wrong account", accountId: "other" },
    { name: "missing current target", toolContext: { currentChannelProvider: "telegram" } },
  ])("rejects cache reads with $name", async ({ name: _name, ...override }) => {
    await expectDenied({ ...context, ...override });
  });
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
  activate(
    discoveryPlugin("demo-buttons", () => ({ actions: ["send"], capabilities: ["presentation"] })),
    discoveryPlugin("demo-cards", () => ({ actions: ["send"], capabilities: ["delivery-pin"] })),
  );
}

describe("message action discovery", () => {
  it("aggregates capabilities across plugins", () => {
    activateCapabilities();
    expect(channelSupportsMessageCapability({}, "presentation")).toBe(true);
    expect(channelSupportsMessageCapability({}, "delivery-pin")).toBe(true);
  });

  it("does not replace an explicitly empty prepared catalog", () => {
    activateCapabilities();
    const preparedMessageToolCatalog = { version: 0, channels: [], getChannel: () => undefined };
    expect(channelSupportsMessageCapability({}, "presentation", preparedMessageToolCatalog)).toBe(
      false,
    );
    expect(
      resolveChannelMessageToolSchemaProperties({
        cfg: {},
        channel: "demo-buttons",
        preparedMessageToolCatalog,
      }),
    ).toEqual({});
  });

  it("evaluates prepared discovery against each account context", () => {
    const plugin = discoveryPlugin("demo-account-scoped", ({ accountId }) => ({
      actions: ["send"],
      capabilities: accountId === "first" ? ["presentation"] : ["delivery-pin"],
    }));
    activate(plugin);
    const preparedMessageToolCatalog = getPreparedMessageToolCatalog();
    const supports = (accountId: string, capability: ChannelMessageCapability) =>
      channelSupportsMessageCapabilityForChannel(
        { cfg: {}, channel: plugin.id, accountId, preparedMessageToolCatalog },
        capability,
      );
    expect(supports("first", "presentation")).toBe(true);
    expect(supports("second", "presentation")).toBe(false);
    expect(supports("second", "delivery-pin")).toBe(true);
  });

  it("normalizes channel aliases for capability checks", () => {
    const plugin = discoveryPlugin("demo-cards", () => ({
      actions: ["send"],
      capabilities: ["delivery-pin"],
    }));
    plugin.meta.aliases = ["demo-cards-alias"];
    activate(plugin);
    expect(
      channelSupportsMessageCapabilityForChannel(
        { cfg: {}, channel: "demo-cards-alias" },
        "delivery-pin",
      ),
    ).toBe(true);
  });

  it("does not grant a channel capability without a channel", () => {
    activateCapabilities();
    expect(channelSupportsMessageCapabilityForChannel({ cfg: {} }, "delivery-pin")).toBe(false);
  });

  it("keeps all-configured schema account-neutral from another current channel", () => {
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
    const properties = resolveChannelMessageToolSchemaProperties({
      cfg: {},
      channel: "slack",
      accountId: "slack-workspace",
    });
    expect(properties).toHaveProperty("components");
    expect(properties).not.toHaveProperty("emoji");
  });

  it("keeps required and serialized contributed properties optional", () => {
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
    const properties = resolveChannelMessageToolSchemaProperties({
      cfg: {},
      channel: "demo-contrib",
    });
    expect(Type.Object({ action: Type.String(), ...properties }).required).toEqual(["action"]);
  });

  it("filters only actions dependent on current-channel-only schema", () => {
    activate(
      discoveryPlugin("demo-scoped-schema", () => ({
        actions: ["read", "list-pins", "unpin"],
        schema: {
          actions: ["unpin"],
          properties: { pinnedMessageId: Type.Optional(Type.String()) },
        },
      })),
    );
    expect(
      listCrossChannelSchemaSupportedMessageActions({ cfg: {}, channel: "demo-scoped-schema" }),
    ).toEqual(["read", "list-pins"]);
  });

  it("blocks cross-channel actions for unscoped current-channel schema", () => {
    activate(
      discoveryPlugin("demo-unscoped-schema", () => ({
        actions: ["read", "unpin"],
        schema: { properties: { pinnedMessageId: Type.Optional(Type.String()) } },
      })),
    );
    expect(
      listCrossChannelSchemaSupportedMessageActions({ cfg: {}, channel: "demo-unscoped-schema" }),
    ).toStrictEqual([]);
  });

  it("derives media-source params for the current action", () => {
    activate(
      discoveryPlugin("demo-media", () => ({
        actions: ["send", "set-profile"],
        mediaSourceParams: { "set-profile": ["avatarUrl", "avatarPath"] },
      })),
    );
    expect(
      resolveChannelMessageToolMediaSourceParamKeys({
        cfg: {},
        action: "set-profile",
        channel: "demo-media",
      }),
    ).toEqual(["avatarUrl", "avatarPath"]);
    expect(
      resolveChannelMessageToolMediaSourceParamKeys({
        cfg: {},
        action: "send",
        channel: "demo-media",
      }),
    ).toStrictEqual([]);
  });

  it("keeps flat media-source parameter discovery", () => {
    activate(
      discoveryPlugin("demo-media-flat", () => ({
        actions: ["set-profile"],
        mediaSourceParams: ["avatarUrl", "avatarPath"],
      })),
    );
    expect(
      resolveChannelMessageToolMediaSourceParamKeys({
        cfg: {},
        action: "set-profile",
        channel: "demo-media-flat",
      }),
    ).toEqual(["avatarUrl", "avatarPath"]);
  });

  it("skips crashing discovery and logs once", () => {
    const errorSpy = vi.spyOn(defaultRuntime, "error").mockImplementation(() => undefined);
    activate(
      discoveryPlugin("demo-crashing", () => {
        throw new Error("boom");
      }),
    );
    expect(channelSupportsMessageCapability({}, "presentation")).toBe(false);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(channelSupportsMessageCapability({}, "presentation")).toBe(false);
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });
});
