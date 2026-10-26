// Covers outbound direct target resolution and explicit proactive delivery policy.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelPlugin } from "../../channels/plugins/types.public.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import { getActivePluginRegistry, setActivePluginRegistry } from "../../plugins/runtime.js";
import { setActiveDegradedSecretOwners } from "../../secrets/runtime-degraded-state.js";
import { normalizeSessionDeliveryState } from "../../utils/delivery-context.shared.js";
import type { DeliveryContext } from "../../utils/delivery-context.types.js";
import {
  hasResolvableProactiveOwnerRoute,
  resolveProactiveDeliveryTarget,
  resolveProactiveDeliveryTargetWithSessionRoute,
  resolveSessionDeliveryTarget,
} from "./targets.js";
import type { SessionDeliveryTarget } from "./targets.js";
import { runResolveOutboundTargetCoreTests } from "./targets.shared-test.js";
import {
  createForumTargetTestPlugin,
  createGenericTargetTestPlugin,
  createTestChannelPlugin,
  createTargetsTestRegistry,
} from "./targets.test-helpers.js";

const mocks = vi.hoisted(() => ({
  normalizeDeliverableOutboundChannel: vi.fn(),
  resolveOutboundChannelPlugin: vi.fn(),
}));

type SessionFixture = {
  deliveryContext?: DeliveryContext;
  chatType?: SessionEntry["chatType"];
  lastChannel?: string;
  lastTo?: string;
  lastAccountId?: string;
  lastThreadId?: string | number;
};

const passthroughOutbound: NonNullable<ChannelPlugin["outbound"]> = {
  deliveryMode: "direct",
  resolveTarget: ({ to }) =>
    to
      ? { ok: true as const, to: to.trim() }
      : { ok: false as const, error: new Error("target required") },
};

function setPlugins(...plugins: ChannelPlugin[]) {
  setActivePluginRegistry(createTargetsTestRegistry(plugins));
}

function directoryTarget(kind: "user" | "group") {
  return async ({ normalized }: { normalized: string }) => ({
    to: normalized,
    kind,
    source: "directory" as const,
  });
}

function route(channel: string, target: string, chatType: "direct" | "group") {
  const scope = chatType === "direct" ? "user" : "group";
  const sessionKey = `main:${channel}:${scope}:${target}`;
  return {
    sessionKey,
    baseSessionKey: sessionKey,
    peer: { kind: chatType, id: target },
    chatType,
    from: chatType === "group" ? `${channel}:group:${target}` : `${channel}:${target}`,
    to: target,
  };
}

function ownerPlugin(
  id: ChannelPlugin["id"],
  ownerId: string,
  inferTargetChatType?: NonNullable<ChannelPlugin["messaging"]>["inferTargetChatType"],
): ChannelPlugin {
  const plugin = createTestChannelPlugin({
    id,
    outbound: passthroughOutbound,
    messaging: {
      ...(inferTargetChatType ? { inferTargetChatType } : {}),
      // Real channel plugins declare their id as a target prefix; prefixed
      // configured-owner entries rely on it to bind to the right channel.
      targetPrefixes: [String(id)],
      targetResolver: { looksLikeId: () => true },
    },
  });
  plugin.config = { ...plugin.config, resolveAllowFrom: () => [ownerId] };
  return plugin;
}

vi.mock("./channel-resolution.js", () => ({
  normalizeDeliverableOutboundChannel: mocks.normalizeDeliverableOutboundChannel,
  resolveOutboundChannelPlugin: mocks.resolveOutboundChannelPlugin,
}));

runResolveOutboundTargetCoreTests();

afterEach(() => {
  setActiveDegradedSecretOwners([]);
});

beforeEach(() => {
  mocks.normalizeDeliverableOutboundChannel.mockReset();
  mocks.normalizeDeliverableOutboundChannel.mockImplementation((value?: string | null) => {
    const normalized = typeof value === "string" ? value.trim().toLowerCase() : undefined;
    return ["alpha", "beta", "forum", "googlechat", "telegram", "whatsapp"].includes(
      String(normalized),
    )
      ? normalized
      : undefined;
  });
  mocks.resolveOutboundChannelPlugin.mockReset();
  mocks.resolveOutboundChannelPlugin.mockImplementation(
    ({ channel }: { channel: string }) =>
      getActivePluginRegistry()?.channels.find((entry) => entry?.plugin?.id === channel)?.plugin,
  );
  setActivePluginRegistry(createTargetsTestRegistry());
});

function session(fields: SessionFixture): SessionEntry {
  const context = fields.deliveryContext ?? {
    channel: fields.lastChannel,
    to: fields.lastTo,
    accountId: fields.lastAccountId,
    threadId: fields.lastThreadId,
  };
  return {
    sessionId: "session",
    updatedAt: 1,
    chatType: fields.chatType,
    delivery: normalizeSessionDeliveryState({ context }),
  };
}

type SessionTargetCase = {
  name: string;
  input: Parameters<typeof resolveSessionDeliveryTarget>[0];
  expected: Partial<SessionDeliveryTarget>;
};

describe("resolveSessionDeliveryTarget", () => {
  it("selects the unsupported channel fallback", () => {
    const resolved = resolveSessionDeliveryTarget({
      entry: session({ lastChannel: "alpha", lastTo: "room-one" }),
      requestedChannel: "webchat",
      fallbackChannel: "beta",
    });
    expect(resolved).toEqual({
      channel: "beta",
      to: undefined,
      accountId: undefined,
      threadId: undefined,
      mode: "implicit",
      lastChannel: "alpha",
      lastTo: "room-one",
      lastAccountId: undefined,
      lastThreadId: undefined,
    });
  });

  it("selects an explicit provider prefix before session fallback", () => {
    const resolved = resolveSessionDeliveryTarget({
      entry: session({ lastChannel: "alpha", lastTo: "room-one" }),
      requestedChannel: "last",
      explicitTo: "beta:room-two",
    });
    expect(resolved).toMatchObject({ channel: "beta", to: "beta:room-two", lastChannel: "alpha" });
  });

  it("never reuses a group route for implicit owner delivery", async () => {
    const forum = createForumTargetTestPlugin();
    forum.config = {
      ...forum.config,
      resolveAllowFrom: () => ["dm:operator"],
    };
    setPlugins(forum);

    const resolved = await resolveProactiveDeliveryTarget({
      cfg: { channels: { forum: { allowFrom: ["dm:operator"] } } } as OpenClawConfig,
      entry: session({
        lastChannel: "forum",
        lastTo: "room:ops",
        chatType: "group",
      }),
      policy: { to: "group:wrong" },
    });

    expect(resolved).toMatchObject({ channel: "forum", to: "dm:operator", chatType: "direct" });
  });

  it.each(["plain", "channel-scoped"] as const)("rejects %s wildcard owners", async (kind) => {
    const scoped = kind === "channel-scoped";
    const channel = scoped ? "telegram" : "alpha";
    const allowFrom = scoped ? ["telegram:*"] : ["", "*"];
    const plugin = scoped
      ? ownerPlugin(channel, allowFrom[0] ?? "", () => "direct")
      : createGenericTargetTestPlugin("alpha", "Alpha");
    plugin.config = { ...plugin.config, resolveAllowFrom: () => allowFrom };
    setPlugins(plugin);
    const resolved = await resolveProactiveDeliveryTarget({
      cfg: {
        commands: { ownerAllowFrom: allowFrom },
        channels: { [channel]: { allowFrom: scoped ? allowFrom : ["*"] } },
      },
      policy: scoped ? { target: "owner" } : undefined,
    });
    expect(resolved).toMatchObject({ channel: "none", reason: "no-route" });
  });

  it.each(["cold", "disabled"] as const)(
    "keeps proactive owner discovery usable when an account is %s",
    async (state) => {
      const alpha = ownerPlugin("alpha", "user:alpha-owner", () => "direct");
      const beta = ownerPlugin("beta", "user:beta-owner", () => "direct");
      const resolveAllowFrom = vi.fn(() => {
        throw new Error("unavailable credential must not resolve for owner discovery");
      });
      alpha.config = {
        ...alpha.config,
        listAccountIds: () => ["work"],
        inspectAccount: () => ({
          enabled: state !== "disabled",
          configured: true,
          tokenStatus: "available",
        }),
        resolveAllowFrom,
      };
      beta.config.listAccountIds = () => ["work"];
      setPlugins(alpha, beta);
      if (state === "cold") {
        setActiveDegradedSecretOwners([
          {
            ownerKind: "account",
            ownerId: "alpha:work",
            state: "unavailable",
            degradationState: state,
            paths: ["channels.alpha.accounts.work.token"],
            refKeys: [],
            reason: "secret reference was not found",
          },
        ]);
      }
      const cfg = { channels: { alpha: {}, beta: {} } } as OpenClawConfig;

      expect(
        await resolveProactiveDeliveryTarget({ cfg, policy: { accountId: "work" } }),
      ).toMatchObject({
        channel: "beta",
        accountId: "work",
        to: "user:beta-owner",
      });
      expect(resolveAllowFrom).not.toHaveBeenCalled();
    },
  );

  it("keeps owner discovery fail-closed for unresolved store SecretRefs and resolves once the credential is materialized", async () => {
    const telegram = ownerPlugin("telegram", "123456789", ({ to }) =>
      /^\d+$/.test(to) ? "direct" : undefined,
    );
    telegram.config = {
      ...telegram.config,
      listAccountIds: () => ["default"],
      inspectAccount: (cfg: OpenClawConfig) => {
        const botToken = cfg.channels?.telegram?.botToken;
        return typeof botToken === "string" && botToken.trim()
          ? { enabled: true, configured: true, token: botToken, tokenStatus: "available" }
          : { enabled: true, configured: true, tokenStatus: "configured_unavailable" };
      },
    };
    setPlugins(telegram);

    const unresolvedCfg: OpenClawConfig = {
      commands: { ownerAllowFrom: ["telegram:123456789"] },
      channels: {
        telegram: {
          enabled: true,
          botToken: { source: "store", provider: "default", id: "TELEGRAM_BOT_TOKEN" },
        },
      },
    };
    expect(await hasResolvableProactiveOwnerRoute({ cfg: unresolvedCfg })).toBe(false);

    // Materializing the credential makes the same owner routable (#137217).
    const resolvedCfg: OpenClawConfig = {
      commands: { ownerAllowFrom: ["telegram:123456789"] },
      channels: { telegram: { enabled: true, botToken: "8905123456:AAF-example-bDTs" } },
    };
    expect(await hasResolvableProactiveOwnerRoute({ cfg: resolvedCfg })).toBe(true);
  });

  it("reuses an exact direct owner route with its account and thread", async () => {
    const alpha = createGenericTargetTestPlugin("alpha", "Alpha");
    setPlugins(alpha);

    const resolved = await resolveProactiveDeliveryTarget({
      cfg: { commands: { ownerAllowFrom: ["alpha:user:owner"] } },
      entry: session({
        lastChannel: "alpha",
        lastTo: "user:owner",
        lastAccountId: "work",
        lastThreadId: "thread-7",
        chatType: "direct",
      }),
    });

    expect(resolved).toMatchObject({
      channel: "alpha",
      to: "user:owner",
      accountId: "work",
      threadId: "thread-7",
      chatType: "direct",
    });
  });

  it("reports no proactive route without a concrete last target", async () => {
    setPlugins();
    const resolved = await resolveProactiveDeliveryTarget({
      cfg: {},
      entry: session({ lastChannel: "forum" }),
      policy: { target: "last", accountId: "configured-account" },
    });
    expect(resolved).toMatchObject({ channel: "none", reason: "no-route" });
    expect(mocks.resolveOutboundChannelPlugin).not.toHaveBeenCalled();
  });

  it("allows proactive delivery to plugin-classified direct chats by default", async () => {
    const resolved = await resolveProactiveDeliveryTarget({
      cfg: {},
      entry: session({ lastChannel: "forum", lastTo: "dm:one" }),
      policy: { target: "last" },
    });
    expect(resolved).toMatchObject({
      channel: "forum",
      to: "dm:one",
      reason: undefined,
      threadId: undefined,
    });
  });

  it("preserves the canonical proactive target after route resolution", async () => {
    const cfg: OpenClawConfig = {};
    const proactive = { target: "forum", to: "room:ops:topic:1008013" };
    const resolved = await resolveProactiveDeliveryTargetWithSessionRoute({
      cfg,
      agentId: "main",
      policy: proactive,
    });
    expect(resolved).toMatchObject({ channel: "forum", to: "room:ops", threadId: 1008013 });
  });

  it("upgrades an owner-route setup shell with the selected agent runtime", async () => {
    const runtime = ownerPlugin("forum", "user:ops", () => "direct");
    const setup = { ...runtime, outbound: undefined };
    setPlugins(setup);
    mocks.resolveOutboundChannelPlugin.mockImplementation(
      ({
        channel,
        agentId,
        allowBootstrap,
      }: {
        channel: string;
        agentId?: string;
        allowBootstrap?: boolean;
      }) => (channel === "forum" && agentId === "ops" && allowBootstrap === true ? runtime : setup),
    );
    const cfg = { channels: { forum: {} } } as OpenClawConfig;

    const resolved = await resolveProactiveDeliveryTarget({
      cfg,
      agentId: "ops",
      policy: { target: "owner" },
    });

    expect(resolved).toMatchObject({ channel: "forum", to: "user:ops" });
  });

  it.each([
    {
      name: "invalid target",
      to: "invalid",
      accountId: undefined,
      expected: { channel: "none", reason: "no-target" },
    },
    {
      name: "invalid account",
      to: "room:ops",
      accountId: "missing-account",
      expected: { channel: "none", reason: "unknown-account" },
    },
  ])("validates a bootstrapped plugin's $name", async ({ to, accountId, expected }) => {
    const forum = createForumTargetTestPlugin();
    if (accountId) {
      forum.config = { ...forum.config, listAccountIds: () => ["valid-account"] };
    }
    setPlugins();
    mocks.resolveOutboundChannelPlugin.mockImplementation(
      ({ channel, allowBootstrap }: { channel: string; allowBootstrap?: boolean }) =>
        channel === "forum" && allowBootstrap === true ? forum : undefined,
    );
    const resolved = await resolveProactiveDeliveryTarget({
      cfg: {},
      entry: session({ lastChannel: "forum", lastTo: to }),
      policy: { target: "last", accountId },
    });
    expect(resolved).toMatchObject(expected);
  });

  it("uses explicit direct policy without inheriting retired heartbeat defaults", async () => {
    const alpha = createGenericTargetTestPlugin("alpha", "Alpha");
    const routedAlpha: ChannelPlugin = {
      ...alpha,
      messaging: {
        ...alpha.messaging,
        resolveOutboundSessionRoute: () => ({
          ...route("alpha", "u123", "direct"),
          to: "user:u123",
        }),
      },
    };
    setPlugins(routedAlpha);
    const policy = { target: "last", directPolicy: "block" } as const;
    const entry = session({ lastChannel: "alpha", lastTo: "channel:D123" });
    expect(
      await resolveProactiveDeliveryTargetWithSessionRoute({
        cfg: { agents: { defaults: { heartbeat: policy } } },
        policy: { target: "last" },
        agentId: "main",
        entry,
      }),
    ).toMatchObject({ channel: "alpha", to: "user:u123", chatType: "direct" });
    const resolved = await resolveProactiveDeliveryTargetWithSessionRoute({
      cfg: {},
      policy,
      agentId: "main",
      entry,
    });
    expect(resolved).toMatchObject({ channel: "none", reason: "dm-blocked" });
  });

  it("uses resolved target kind before applying proactive directPolicy to routed handles", async () => {
    setPlugins(
      createTestChannelPlugin({
        id: "telegram",
        outbound: passthroughOutbound,
        messaging: {
          targetPrefixes: ["telegram"],
          inferTargetChatType: () => "group",
          targetResolver: {
            resolveTarget: directoryTarget("group"),
          },
          resolveOutboundSessionRoute: ({ target, resolvedTarget }) => {
            return route("telegram", target, resolvedTarget?.kind === "group" ? "group" : "direct");
          },
        },
      }),
    );

    const resolved = await resolveProactiveDeliveryTargetWithSessionRoute({
      cfg: {},
      agentId: "main",
      policy: {
        target: "telegram",
        to: "@public_group",
        directPolicy: "block",
      },
    });

    expect(resolved).toMatchObject({ channel: "telegram", to: "@public_group", chatType: "group" });
  });

  it("rejects an owner destination whose canonical session route is a group", async () => {
    const alpha = createTestChannelPlugin({
      id: "alpha",
      outbound: passthroughOutbound,
      messaging: {
        inferTargetChatType: () => "direct",
        targetResolver: {
          resolveTarget: directoryTarget("user"),
        },
        resolveOutboundSessionRoute: ({ target }) => route("alpha", target, "group"),
      },
    });
    alpha.config = { ...alpha.config, resolveAllowFrom: () => ["operator"] };
    setPlugins(alpha);

    const resolved = await resolveProactiveDeliveryTargetWithSessionRoute({
      cfg: { channels: { alpha: { allowFrom: ["operator"] } } } as OpenClawConfig,
      agentId: "main",
      policy: { target: "owner" },
    });

    expect(resolved).toMatchObject({ channel: "none", reason: "no-route" });
  });

  it.each([
    {
      name: "user-prefixed group",
      id: "telegram",
      ownerId: "user:shared",
      classify: () => "group",
    },
    { name: "unclassified opaque id", id: "external-channel", ownerId: "opaque-owner-id" },
  ] satisfies Array<{
    name: string;
    id: ChannelPlugin["id"];
    ownerId: string;
    classify?: NonNullable<ChannelPlugin["messaging"]>["inferTargetChatType"];
  }>)("requires a proven direct owner route for $name", async ({ id, ownerId, classify }) => {
    const plugin = ownerPlugin(id, ownerId, classify);
    setPlugins(plugin);
    const resolved = await resolveProactiveDeliveryTargetWithSessionRoute({
      cfg: { channels: { [id]: { allowFrom: [ownerId] } } },
      agentId: "main",
      policy: { target: "owner" },
    });
    expect(resolved).toMatchObject({ channel: "none", reason: "no-route" });
  });

  it("prefers a prefixed configured owner on a later channel over session-channel allowFrom", async () => {
    const slack = ownerPlugin("slack", "user:slack-local", ({ to }) =>
      /^user:/i.test(to) ? "direct" : undefined,
    );
    const telegram = ownerPlugin("telegram", "999", ({ to }) =>
      /^\d+$/.test(to) ? "direct" : undefined,
    );
    setPlugins(slack, telegram);

    const resolved = await resolveProactiveDeliveryTarget({
      cfg: {
        commands: { ownerAllowFrom: ["telegram:456"] },
        channels: {
          slack: { allowFrom: ["user:slack-local"] },
          telegram: { allowFrom: ["999"] },
        },
      } as OpenClawConfig,
      entry: session({
        lastChannel: "slack",
        lastTo: "user:someone",
        chatType: "direct",
      }),
      policy: { target: "owner" },
    });

    // Precedence and channel binding are under test; the passthrough fixture
    // resolveTarget keeps the raw prefixed form (stripping is covered elsewhere).
    expect(resolved).toMatchObject({ channel: "telegram", to: "telegram:456" });
  });

  it("delivers a classifier-proven WhatsApp E.164 owner route", async () => {
    const inferTargetChatType = vi.fn(({ to }: { to: string }) =>
      /^\+\d+$/.test(to) ? ("direct" as const) : undefined,
    );
    const whatsapp = ownerPlugin("whatsapp", "+15555550166", inferTargetChatType);
    setPlugins(whatsapp);
    const cfg = {
      channels: { whatsapp: { allowFrom: ["+15555550166"] } },
    } as OpenClawConfig;

    expect(await hasResolvableProactiveOwnerRoute({ cfg })).toBe(true);

    const resolved = await resolveProactiveDeliveryTargetWithSessionRoute({
      cfg,
      agentId: "main",
      policy: { target: "owner" },
    });

    expect(resolved).toMatchObject({ channel: "whatsapp", to: "+15555550166" });
  });

  it.each(["target-resolver", "infer-only"] as const)(
    "blocks direct targets from activation-aware %s plugins without route hooks",
    async (mode) => {
      const inferOnly = mode === "infer-only";
      const external = createTestChannelPlugin({
        id: "external-channel",
        outbound: { ...passthroughOutbound, ...(inferOnly ? { sendText: vi.fn() } : {}) },
        messaging: inferOnly
          ? { inferTargetChatType: () => "direct" }
          : { targetResolver: { resolveTarget: directoryTarget("user") } },
      });
      const setup = { ...external, messaging: undefined };
      setPlugins();
      mocks.resolveOutboundChannelPlugin.mockImplementation(
        ({ channel, allowBootstrap }: { channel: string; allowBootstrap?: boolean }) => {
          if (channel !== "external-channel") {
            return undefined;
          }
          if (inferOnly) {
            return allowBootstrap === true ? external : setup;
          }
          if (allowBootstrap === true) {
            setPlugins(external);
            return external;
          }
          return getActivePluginRegistry()?.channels.find((entry) => entry?.plugin?.id === channel)
            ?.plugin;
        },
      );

      const params = {
        cfg: {},
        agentId: "main",
        policy: {
          target: "external-channel",
          to: "person-123",
          directPolicy: "block" as const,
        },
      };
      const resolved = await (inferOnly
        ? resolveProactiveDeliveryTarget(params)
        : resolveProactiveDeliveryTargetWithSessionRoute(params));

      expect(resolved).toMatchObject({ channel: "none", reason: "dm-blocked" });
    },
  );

  it.each([
    {
      name: "directory hit",
      groups: [{ kind: "group", id: "-1002458651455", name: "current" }],
      expected: { channel: "telegram", to: "-1002458651455" },
    },
    {
      name: "directory miss fails closed",
      groups: [],
      expected: { channel: "none", reason: "no-target" },
    },
  ])("resolves proactive reserved literals: $name", async ({ groups, expected }) => {
    const listGroups = vi.fn().mockResolvedValue(groups);
    const listGroupsLive = vi.fn().mockResolvedValue([]);
    setPlugins({
      ...createTestChannelPlugin({
        id: "telegram",
        outbound: passthroughOutbound,
        messaging: {
          targetPrefixes: ["telegram", "tg"],
          targetResolver: {
            reservedLiterals: ["current", "self", "this", "me"],
            hint: "<chatId>",
          },
          resolveOutboundSessionRoute: ({ target, resolvedTarget }) => ({
            ...route("telegram", target, "group"),
            peer: { kind: resolvedTarget?.kind === "user" ? "direct" : "group", id: target },
            chatType: resolvedTarget?.kind === "user" ? "direct" : "group",
          }),
        },
      }),
      directory: { listGroups, listGroupsLive },
    });
    const resolved = await resolveProactiveDeliveryTargetWithSessionRoute({
      cfg: {},
      agentId: "main",
      policy: { target: "telegram", to: "current" },
    });
    expect(resolved).toMatchObject(expected);
    expect(listGroups).toHaveBeenCalled();
    if (!groups.length) {
      expect(listGroupsLive).toHaveBeenCalled();
    }
  });

  it("keeps proactive route canonicalization best-effort when route resolution fails", async () => {
    const alpha = createGenericTargetTestPlugin("alpha", "Alpha");
    setPlugins({
      ...alpha,
      messaging: {
        ...alpha.messaging,
        inferTargetChatType: () => "group",
        resolveOutboundSessionRoute: () => {
          throw new Error("route lookup failed");
        },
      },
    });

    const resolved = await resolveProactiveDeliveryTargetWithSessionRoute({
      cfg: {},
      agentId: "main",
      entry: session({
        lastChannel: "alpha",
        lastTo: "group:ops",
      }),
      policy: {
        target: "last",
      },
    });

    expect(resolved).toMatchObject({ channel: "alpha", to: "group:ops", chatType: "group" });
  });

  it.each([
    {
      name: "group deliveryContext",
      entry: session({
        deliveryContext: { channel: "forum", to: "room:ops", threadId: 1122 },
        chatType: "group",
      }),
      to: "room:ops",
      threadId: 1122,
    },
    {
      name: "direct route drops stale thread",
      entry: session({
        lastChannel: "forum",
        lastTo: "dm:one",
        lastThreadId: 1122,
        chatType: "direct",
      }),
      to: "dm:one",
      threadId: undefined,
    },
  ])("inherits proactive threads only for $name", async ({ entry, to, threadId }) => {
    const resolved = await resolveProactiveDeliveryTarget({
      cfg: {},
      entry,
      policy: { target: "last" },
    });
    expect(resolved).toMatchObject({ channel: "forum", to, threadId });
  });

  it.each([
    {
      name: "moved direct session does not block the event group",
      storedTo: "user:operator",
      storedType: "direct",
      eventTo: "group:ops",
      expected: { channel: "alpha", chatType: "group", to: "group:ops" },
    },
    {
      name: "moved group session does not allow the event direct chat",
      storedTo: "group:ops",
      storedType: "group",
      eventTo: "user:operator",
      expected: { channel: "none", chatType: undefined, reason: "dm-blocked", to: undefined },
    },
    {
      name: "same opaque direct conversation retains its hint",
      storedTo: "opaque-dm",
      storedType: "direct",
      eventTo: "opaque-dm",
      expected: { channel: "none", chatType: undefined, reason: "dm-blocked", to: undefined },
    },
  ] as const)(
    "qualifies proactive chat type by the selected conversation: $name",
    async ({ storedTo, storedType, eventTo, expected }) => {
      const resolved = await resolveProactiveDeliveryTargetWithSessionRoute({
        cfg: {},
        agentId: "main",
        entry: session({
          lastChannel: "alpha",
          lastTo: storedTo,
          chatType: storedType,
        }),
        policy: {
          target: eventTo === storedTo ? "last" : "alpha",
          to: eventTo === storedTo ? undefined : eventTo,
          directPolicy: "block",
        },
      });
      expect(resolved).toMatchObject(expected);
    },
  );
});

describe("resolveSessionDeliveryTarget — cross-channel reply guard (#24152)", () => {
  const topic = { lastChannel: "forum", lastTo: "room:ops", lastThreadId: 1122 };
  const changed = { lastChannel: "beta", lastTo: "wrong-room" };
  const topicSession = session(topic);
  const changedSession = session(changed);
  it.each([
    {
      name: "explicit channel overrides turn source",
      input: {
        entry: changedSession,
        requestedChannel: "forum",
        explicitTo: "room:ops",
        turnSourceChannel: "alpha",
        turnSourceTo: "room-one",
      },
      expected: { channel: "forum" },
    },
    {
      name: "turn source owns account and thread",
      input: {
        entry: session({ ...changed, lastAccountId: "wrong-account", lastThreadId: 999 }),
        turnSourceChannel: "forum",
        turnSourceTo: "room:ops",
        turnSourceAccountId: "bot-123",
        turnSourceThreadId: 42,
      },
      expected: { channel: "forum", to: "room:ops", accountId: "bot-123", threadId: 42 },
    },
    {
      name: "turn source channel suppresses stale metadata",
      input: {
        entry: session({ ...changed, lastAccountId: "wrong-account", lastThreadId: "thread-1" }),
        turnSourceChannel: "alpha",
      },
      expected: {
        channel: "alpha",
        to: undefined,
        accountId: undefined,
        threadId: undefined,
        lastTo: undefined,
        lastAccountId: undefined,
        lastThreadId: undefined,
      },
    },
    {
      name: "same conversation inherits session topic",
      input: {
        entry: session({ ...topic, lastAccountId: "work" }),
        turnSourceChannel: "forum",
        turnSourceTo: "room:ops",
        turnSourceAccountId: "work",
      },
      expected: {
        channel: "forum",
        to: "room:ops",
        accountId: "work",
        threadId: 1122,
        threadIdSource: "session",
      },
    },
    {
      name: "different account cannot inherit session topic",
      input: {
        entry: session({ ...topic, lastAccountId: "personal" }),
        turnSourceChannel: "forum",
        turnSourceTo: "room:ops",
        turnSourceAccountId: "work",
      },
      expected: {
        accountId: "work",
        threadId: undefined,
        threadIdSource: undefined,
        lastThreadId: undefined,
      },
    },
    {
      name: "bare stored destination does not match topic-scoped turn",
      input: {
        entry: topicSession,
        turnSourceChannel: "forum",
        turnSourceTo: "forum:room:ops:topic:1122",
      },
      expected: { channel: "forum", to: "forum:room:ops:topic:1122", threadId: undefined },
    },
    {
      name: "different destination cannot inherit session thread",
      input: { entry: topicSession, turnSourceChannel: "forum", turnSourceTo: "room:other" },
      expected: { channel: "forum", to: "room:other", threadId: undefined },
    },
  ] satisfies SessionTargetCase[])("$name", ({ input, expected }) => {
    expect(resolveSessionDeliveryTarget({ requestedChannel: "last", ...input })).toMatchObject(
      expected,
    );
  });
});
