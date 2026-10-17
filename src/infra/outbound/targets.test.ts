// Covers outbound direct target resolution, heartbeat target derivation,
// heartbeat sender context, and route-aware heartbeat refinements.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelOutboundSessionRoute } from "../../channels/plugins/types.core.js";
import type {
  ChannelMessagingAdapter,
  ChannelOutboundAdapter,
  ChannelPlugin,
} from "../../channels/plugins/types.public.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { ChannelRouteRef } from "../../plugin-sdk/channel-route.js";
import { getActivePluginRegistry, setActivePluginRegistry } from "../../plugins/runtime.js";
import { setActiveDegradedSecretOwners } from "../../secrets/runtime-degraded-state.js";
import type { DeliveryContext } from "../../utils/delivery-context.types.js";
import { normalizeLegacySessionEntryDelivery } from "../state-migrations.legacy-session-store.js";
import {
  hasResolvableHeartbeatOwnerRoute,
  resolveHeartbeatDeliveryTarget as resolveCanonicalHeartbeatDeliveryTarget,
  resolveHeartbeatDeliveryTargetWithSessionRoute as resolveCanonicalHeartbeatDeliveryTargetWithSessionRoute,
  resolveOutboundTarget,
  resolveSessionDeliveryTarget as resolveCanonicalSessionDeliveryTarget,
} from "./targets.js";
import type { SessionDeliveryTarget } from "./targets.js";
import {
  installResolveOutboundTargetPluginRegistryHooks,
  runResolveOutboundTargetCoreTests,
} from "./targets.shared-test.js";
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

type LegacyDeliveryFixture = SessionEntry & {
  route?: ChannelRouteRef;
  deliveryContext?: DeliveryContext;
  origin?: { provider?: string; accountId?: string; threadId?: string | number };
  channel?: string;
  lastChannel?: string;
  lastTo?: string;
  lastAccountId?: string;
  lastThreadId?: string | number;
};

function resolveSessionDeliveryTarget(
  params: Omit<Parameters<typeof resolveCanonicalSessionDeliveryTarget>[0], "entry"> & {
    entry?: LegacyDeliveryFixture;
  },
) {
  return resolveCanonicalSessionDeliveryTarget({
    ...params,
    entry: params.entry ? normalizeLegacySessionEntryDelivery(params.entry) : undefined,
  });
}

type HeartbeatFixture = Omit<
  Parameters<typeof resolveCanonicalHeartbeatDeliveryTarget>[0],
  "entry" | "cfg"
> & { cfg?: OpenClawConfig; entry?: LegacyDeliveryFixture };

function resolveHeartbeatDeliveryTarget(params: HeartbeatFixture) {
  return resolveCanonicalHeartbeatDeliveryTarget({
    cfg: {},
    ...params,
    entry: params.entry ? normalizeLegacySessionEntryDelivery(params.entry) : undefined,
  });
}

async function resolveHeartbeatDeliveryTargetWithSessionRoute(
  params: HeartbeatFixture & { currentSessionKey?: string },
) {
  return await resolveCanonicalHeartbeatDeliveryTargetWithSessionRoute({
    cfg: {},
    agentId: "main",
    ...params,
    entry: params.entry ? normalizeLegacySessionEntryDelivery(params.entry) : undefined,
  });
}

const passthroughOutbound: ChannelOutboundAdapter = {
  deliveryMode: "direct",
  resolveTarget: ({ to }) =>
    to ? { ok: true, to: to.trim() } : { ok: false, error: new Error("target required") },
};

function installPlugins(...plugins: ChannelPlugin[]) {
  setActivePluginRegistry(createTargetsTestRegistry(plugins));
}

function directoryResolver(
  kind: "user" | "group",
): NonNullable<ChannelMessagingAdapter["targetResolver"]> {
  return {
    resolveTarget: async ({ normalized }) => ({ to: normalized, kind, source: "directory" }),
  };
}

function sessionRoute(
  channel: string,
  target: string,
  chatType: "direct" | "group",
  overrides: Partial<ChannelOutboundSessionRoute> = {},
): ChannelOutboundSessionRoute {
  const key = `main:${channel}:${chatType === "direct" ? "user" : "group"}:${target}`;
  return {
    sessionKey: key,
    baseSessionKey: key,
    peer: { kind: chatType, id: target },
    chatType,
    from: chatType === "direct" ? `${channel}:${target}` : `${channel}:group:${target}`,
    to: target,
    ...overrides,
  };
}

const ownerLabels: Record<string, string> = {
  alpha: "Alpha",
  beta: "Beta",
  forum: "Forum",
  telegram: "Telegram",
  slack: "Slack",
  whatsapp: "WhatsApp",
};

type InferChatType = NonNullable<ChannelPlugin["messaging"]>["inferTargetChatType"];

function ownerPlugin(
  id: ChannelPlugin["id"],
  ownerId: string,
  inferTargetChatType?: InferChatType,
  label = ownerLabels[id] ?? String(id),
): ChannelPlugin {
  const plugin = createTestChannelPlugin({
    id,
    label,
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

function session(fields: Partial<LegacyDeliveryFixture> = {}): LegacyDeliveryFixture {
  return { sessionId: "session", updatedAt: 1, ...fields };
}

type SessionTargetCase = [
  name: string,
  entry: LegacyDeliveryFixture,
  source: DeliveryContext,
  expected: Partial<SessionDeliveryTarget>,
  explicit?: Pick<
    Parameters<typeof resolveSessionDeliveryTarget>[0],
    "requestedChannel" | "explicitTo"
  >,
];

describe("resolveOutboundTarget defaultTo config fallback", () => {
  installResolveOutboundTargetPluginRegistryHooks();

  it("falls back to the active registry when the cached channel map is stale", async () => {
    const registry = createTargetsTestRegistry([]);
    setActivePluginRegistry(registry, "stale-registry-test");
    expect(
      (await resolveOutboundTarget({ channel: "alpha", to: "room-one", mode: "explicit" })).ok,
    ).toBe(false);
    registry.channels.push({
      pluginId: "alpha",
      plugin: createGenericTargetTestPlugin("alpha", "Alpha"),
      source: "test",
    });
    expect(
      await resolveOutboundTarget({ channel: "alpha", to: "room-one", mode: "explicit" }),
    ).toEqual({ ok: true, to: "room-one" });
  });
});

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

  it.each([
    [
      "implicit origin",
      "chat:stale",
      { channel: "beta", to: "chat:event", threadId: "77" },
      { channel: "beta", to: "chat:event", threadId: "77" },
      undefined,
    ],
    [
      "explicit suppression",
      "chat:one",
      { channel: "alpha", to: "chat:one" },
      { channel: "none", reason: "target-none" },
      "none",
    ],
  ] as const)(
    "honors heartbeat event routing for %s",
    async (_name, lastTo, turnSource, expected, target) => {
      const resolved = await resolveHeartbeatDeliveryTarget({
        entry: session({ lastChannel: "alpha", lastTo }),
        heartbeat: target ? { target } : undefined,
        turnSource,
      });
      expect(resolved).toMatchObject(expected);
    },
  );

  it("never reuses a group route for implicit owner delivery", async () => {
    const forum = createForumTargetTestPlugin();
    forum.config = { ...forum.config, resolveAllowFrom: () => ["dm:operator"] };
    installPlugins(forum);

    const resolved = await resolveHeartbeatDeliveryTarget({
      cfg: { channels: { forum: { allowFrom: ["dm:operator"] } } } as OpenClawConfig,
      entry: session({ lastChannel: "forum", lastTo: "room:ops", chatType: "group" }),
      heartbeat: { to: "group:wrong" },
    });

    expect(resolved).toMatchObject({ channel: "forum", to: "dm:operator", chatType: "direct" });
  });

  it.each([
    {
      name: "wildcard-only owners fail closed",
      plugin: () => {
        const plugin = createGenericTargetTestPlugin("alpha", "Alpha");
        plugin.config.resolveAllowFrom = () => ["", "*"];
        return plugin;
      },
      cfg: { commands: { ownerAllowFrom: ["", "*"] }, channels: { alpha: { allowFrom: ["*"] } } },
      heartbeat: undefined,
    },
    {
      name: "channel-scoped wildcard owners fail closed",
      plugin: () => ownerPlugin("telegram", "telegram:*", () => "direct"),
      cfg: {
        commands: { ownerAllowFrom: ["telegram:*"] },
        channels: { telegram: { allowFrom: ["telegram:*"] } },
      },
      heartbeat: { target: "owner" },
    },
  ])("selects heartbeat owners: $name", async ({ plugin, cfg, heartbeat }) => {
    installPlugins(plugin());
    expect(await resolveHeartbeatDeliveryTarget({ cfg, heartbeat })).toMatchObject({
      channel: "none",
      reason: "no-route",
    });
  });

  it.each(["cold", "disabled"] as const)(
    "keeps heartbeat owner discovery usable when an account is %s",
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
      installPlugins(alpha, beta);
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
        await hasResolvableHeartbeatOwnerRoute({ cfg, heartbeat: { accountId: "work" } }),
      ).toBe(true);
      expect(
        await resolveHeartbeatDeliveryTarget({ cfg, heartbeat: { accountId: "work" } }),
      ).toMatchObject({ channel: "beta", accountId: "work", to: "user:beta-owner" });
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
    installPlugins(telegram);

    // A store-backed SecretRef that this command path could not resolve must keep
    // owner discovery fail-closed instead of reporting a phantom route.
    const unresolvedCfg: OpenClawConfig = {
      commands: { ownerAllowFrom: ["telegram:123456789"] },
      channels: {
        telegram: {
          enabled: true,
          botToken: { source: "store", provider: "default", id: "TELEGRAM_BOT_TOKEN" },
        },
      },
    };
    expect(await hasResolvableHeartbeatOwnerRoute({ cfg: unresolvedCfg })).toBe(false);

    // Once the read-only resolution contract materializes the credential, the
    // configured owner route resolves without any other config change (#137217).
    const resolvedCfg: OpenClawConfig = {
      commands: { ownerAllowFrom: ["telegram:123456789"] },
      channels: { telegram: { enabled: true, botToken: "8905123456:AAF-example-bDTs" } },
    };
    expect(await hasResolvableHeartbeatOwnerRoute({ cfg: resolvedCfg })).toBe(true);
  });

  it("reuses an exact direct owner route with its account and thread", async () => {
    const alpha = createGenericTargetTestPlugin("alpha", "Alpha");
    installPlugins(alpha);

    const resolved = await resolveHeartbeatDeliveryTarget({
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

  it("reports no heartbeat route without a concrete last target", async () => {
    installPlugins();
    const resolved = await resolveHeartbeatDeliveryTarget({
      entry: session({ lastChannel: "forum" }),
      heartbeat: { target: "last", accountId: "configured-account" },
    });
    expect(resolved).toMatchObject({ channel: "none", reason: "no-route" });
    expect(mocks.resolveOutboundChannelPlugin).not.toHaveBeenCalled();
  });

  it("allows heartbeat delivery to plugin-classified direct chats by default", async () => {
    const resolved = await resolveHeartbeatDeliveryTarget({
      entry: session({ lastChannel: "forum", lastTo: "dm:one" }),
      heartbeat: { target: "last" },
    });
    expect(resolved).toMatchObject({ channel: "forum", to: "dm:one" });
    expect(resolved.reason).toBeUndefined();
    expect(resolved.threadId).toBeUndefined();
  });

  it("preserves the canonical heartbeat target after route resolution", async () => {
    const cfg: OpenClawConfig = {};
    const heartbeat = { target: "forum", to: "room:ops:topic:1008013" };
    const resolved = await resolveHeartbeatDeliveryTargetWithSessionRoute({ cfg, heartbeat });
    expect(resolved).toMatchObject({ channel: "forum", to: "room:ops", threadId: 1008013 });
    expect(mocks.resolveOutboundChannelPlugin).toHaveBeenCalledWith({
      channel: "forum",
      cfg,
      agentId: "main",
      allowBootstrap: true,
    });
  });

  it("upgrades an owner-route setup shell with the selected agent runtime", async () => {
    const runtime = ownerPlugin("forum", "user:ops", () => "direct");
    const setup = { ...runtime, outbound: undefined };
    installPlugins(setup);
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

    const resolved = await resolveHeartbeatDeliveryTarget({
      cfg,
      agentId: "ops",
      heartbeat: { target: "owner" },
    });

    expect(resolved).toMatchObject({ channel: "forum", to: "user:ops" });
    expect(mocks.resolveOutboundChannelPlugin).toHaveBeenCalledWith({
      channel: "forum",
      cfg,
      agentId: "ops",
      allowBootstrap: true,
    });
  });

  it.each([
    ["invalid target", "invalid", undefined, "no-target"],
    ["invalid account", "room:ops", "missing-account", "unknown-account"],
  ] as const)("validates a bootstrapped plugin's %s", async (_name, to, accountId, reason) => {
    const forum = createForumTargetTestPlugin();
    if (accountId) {
      forum.config = { ...forum.config, listAccountIds: () => ["valid-account"] };
    }
    installPlugins();
    mocks.resolveOutboundChannelPlugin.mockImplementation(
      ({ channel, allowBootstrap }: { channel: string; allowBootstrap?: boolean }) =>
        channel === "forum" && allowBootstrap === true ? forum : undefined,
    );
    const resolved = await resolveHeartbeatDeliveryTarget({
      entry: session({ lastChannel: "forum", lastTo: to }),
      heartbeat: { target: "last", accountId },
    });
    expect(resolved).toMatchObject({ channel: "none", reason });
    expect(
      mocks.resolveOutboundChannelPlugin.mock.calls.filter(
        ([params]) => params.allowBootstrap === true,
      ),
    ).toHaveLength(1);
  });

  it("blocks canonical direct heartbeat routes using configured default policy", async () => {
    const alpha = createGenericTargetTestPlugin("alpha", "Alpha");
    const routedAlpha: ChannelPlugin = {
      ...alpha,
      messaging: {
        ...alpha.messaging,
        resolveOutboundSessionRoute: () =>
          sessionRoute("alpha", "u123", "direct", { to: "user:u123" }),
      },
    };
    installPlugins(routedAlpha);
    const heartbeat = { target: "last", directPolicy: "block" } as const;
    const resolved = await resolveHeartbeatDeliveryTargetWithSessionRoute({
      cfg: { agents: { defaults: { heartbeat } } },
      entry: session({ lastChannel: "alpha", lastTo: "channel:D123" }),
    });
    expect(resolved).toMatchObject({ channel: "none", reason: "dm-blocked" });
  });

  it("uses resolved target kind before applying heartbeat directPolicy to routed handles", async () => {
    installPlugins(
      createTestChannelPlugin({
        id: "telegram",
        label: "Telegram",
        outbound: passthroughOutbound,
        messaging: {
          targetPrefixes: ["telegram"],
          inferTargetChatType: () => "group",
          targetResolver: directoryResolver("group"),
          resolveOutboundSessionRoute: ({ target, resolvedTarget }) =>
            sessionRoute("telegram", target, resolvedTarget?.kind === "group" ? "group" : "direct"),
        },
      }),
    );

    const resolved = await resolveHeartbeatDeliveryTargetWithSessionRoute({
      heartbeat: { target: "telegram", to: "@public_group", directPolicy: "block" },
    });

    expect(resolved).toMatchObject({ channel: "telegram", to: "@public_group", chatType: "group" });
  });

  it("rejects an owner destination whose canonical session route is a group", async () => {
    const alpha = createTestChannelPlugin({
      id: "alpha",
      label: "Alpha",
      outbound: passthroughOutbound,
      messaging: {
        inferTargetChatType: () => "direct",
        targetResolver: directoryResolver("user"),
        resolveOutboundSessionRoute: ({ target }) => sessionRoute("alpha", target, "group"),
      },
    });
    alpha.config = { ...alpha.config, resolveAllowFrom: () => ["operator"] };
    installPlugins(alpha);

    const resolved = await resolveHeartbeatDeliveryTargetWithSessionRoute({
      cfg: { channels: { alpha: { allowFrom: ["operator"] } } } as OpenClawConfig,
      heartbeat: { target: "owner" },
    });

    expect(resolved).toMatchObject({ channel: "none", reason: "no-route" });
  });

  it.each<[string, ChannelPlugin["id"], string, InferChatType?]>([
    ["user-prefixed group", "telegram", "user:shared", () => "group"],
    ["unclassified opaque id", "external-channel", "opaque-owner-id"],
  ])("requires a proven direct owner route for %s", async (_name, id, ownerId, classify) => {
    const plugin = ownerPlugin(id, ownerId, classify, id);
    installPlugins(plugin);
    const resolved = await resolveHeartbeatDeliveryTargetWithSessionRoute({
      cfg: { channels: { [id]: { allowFrom: [ownerId] } } },
      heartbeat: { target: "owner" },
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
    installPlugins(slack, telegram);

    const resolved = await resolveHeartbeatDeliveryTarget({
      cfg: {
        commands: { ownerAllowFrom: ["telegram:456"] },
        channels: {
          slack: { allowFrom: ["user:slack-local"] },
          telegram: { allowFrom: ["999"] },
        },
      } as OpenClawConfig,
      entry: session({ lastChannel: "slack", lastTo: "user:someone", chatType: "direct" }),
      heartbeat: { target: "owner" },
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
    installPlugins(whatsapp);
    const cfg = {
      channels: { whatsapp: { allowFrom: ["+15555550166"] } },
    } as OpenClawConfig;

    expect(await hasResolvableHeartbeatOwnerRoute({ cfg })).toBe(true);

    const resolved = await resolveHeartbeatDeliveryTargetWithSessionRoute({
      cfg,
      heartbeat: { target: "owner" },
    });

    expect(resolved).toMatchObject({ channel: "whatsapp", to: "+15555550166" });
    expect(inferTargetChatType).toHaveBeenCalledWith({ to: "+15555550166" });
  });

  it("blocks direct targets from prepared external target resolvers without route hooks", async () => {
    const external = createTestChannelPlugin({
      id: "external-channel",
      label: "External",
      outbound: passthroughOutbound,
      messaging: { targetResolver: directoryResolver("user") },
    });
    installPlugins();
    mocks.resolveOutboundChannelPlugin.mockImplementation(
      ({ channel, allowBootstrap }: { channel: string; allowBootstrap?: boolean }) => {
        if (channel !== "external-channel") {
          return undefined;
        }
        if (allowBootstrap === true) {
          setActivePluginRegistry(createTargetsTestRegistry([external]));
          return external;
        }
        return getActivePluginRegistry()?.channels.find((entry) => entry?.plugin?.id === channel)
          ?.plugin;
      },
    );

    const resolved = await resolveHeartbeatDeliveryTargetWithSessionRoute({
      heartbeat: { target: "external-channel", to: "person-123", directPolicy: "block" },
    });

    expect(resolved).toMatchObject({ channel: "none", reason: "dm-blocked" });
  });

  it("uses an activation-aware infer-only plugin for heartbeat direct policy", async () => {
    const external = createTestChannelPlugin({
      id: "external-channel",
      label: "External",
      outbound: { ...passthroughOutbound, sendText: vi.fn() },
      messaging: { inferTargetChatType: () => "direct" },
    });
    const setupExternal = { ...external, messaging: undefined };
    mocks.resolveOutboundChannelPlugin.mockImplementation(
      ({ channel, allowBootstrap }: { channel: string; allowBootstrap?: boolean }) => {
        if (channel !== "external-channel") {
          return undefined;
        }
        return allowBootstrap === true ? external : setupExternal;
      },
    );

    const resolved = await resolveHeartbeatDeliveryTarget({
      heartbeat: { target: "external-channel", to: "person-123", directPolicy: "block" },
    });

    expect(resolved).toMatchObject({ channel: "none", reason: "dm-blocked" });
  });

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
  ])("resolves heartbeat reserved literals: $name", async ({ groups, expected }) => {
    const listGroups = vi.fn().mockResolvedValue(groups);
    const listGroupsLive = vi.fn().mockResolvedValue([]);
    installPlugins({
      ...createTestChannelPlugin({
        id: "telegram",
        label: "Telegram",
        outbound: passthroughOutbound,
        messaging: {
          targetPrefixes: ["telegram", "tg"],
          targetResolver: {
            reservedLiterals: ["current", "self", "this", "me"],
            hint: "<chatId>",
          },
          resolveOutboundSessionRoute: ({ target, resolvedTarget }) => ({
            sessionKey: `main:telegram:group:${target}`,
            baseSessionKey: `main:telegram:group:${target}`,
            peer: { kind: resolvedTarget?.kind === "user" ? "direct" : "group", id: target },
            chatType: resolvedTarget?.kind === "user" ? "direct" : "group",
            from: `telegram:group:${target}`,
            to: target,
          }),
        },
      }),
      directory: { listGroups, listGroupsLive },
    });
    const resolved = await resolveHeartbeatDeliveryTargetWithSessionRoute({
      heartbeat: { target: "telegram", to: "current" },
    });
    expect(resolved).toMatchObject(expected);
    expect(listGroups).toHaveBeenCalled();
    if (!groups.length) {
      expect(listGroupsLive).toHaveBeenCalled();
    }
  });

  it("keeps heartbeat route canonicalization best-effort when route resolution fails", async () => {
    const alpha = createGenericTargetTestPlugin("alpha", "Alpha");
    installPlugins({
      ...alpha,
      messaging: {
        ...alpha.messaging,
        inferTargetChatType: () => "group",
        resolveOutboundSessionRoute: () => {
          throw new Error("route lookup failed");
        },
      },
    });

    const resolved = await resolveHeartbeatDeliveryTargetWithSessionRoute({
      entry: session({ lastChannel: "alpha", lastTo: "group:ops" }),
      heartbeat: { target: "last" },
    });

    expect(resolved).toMatchObject({ channel: "alpha", to: "group:ops", chatType: "group" });
  });

  it.each([
    [
      "group deliveryContext",
      session({
        deliveryContext: { channel: "forum", to: "room:ops", threadId: 1122 },
        chatType: "group",
      }),
      "room:ops",
      1122,
    ],
    [
      "direct route drops stale thread",
      session({ lastChannel: "forum", lastTo: "dm:one", lastThreadId: 1122, chatType: "direct" }),
      "dm:one",
      undefined,
    ],
  ] as const)("inherits heartbeat threads only for %s", async (_name, entry, to, threadId) => {
    const resolved = await resolveHeartbeatDeliveryTarget({ entry, heartbeat: { target: "last" } });
    expect(resolved).toMatchObject({ channel: "forum", to });
    expect(resolved.threadId).toBe(threadId);
  });

  it.each([
    ["direct to group", "user:operator", "direct", "group:ops", "alpha", "group"],
    ["group to direct", "group:ops", "group", "user:operator", "none", undefined],
    ["same opaque direct", "opaque-dm", "direct", "opaque-dm", "none", undefined],
  ] as const)(
    "qualifies heartbeat chat type by the selected conversation: %s",
    async (_name, storedTo, storedType, eventTo, expectedChannel, expectedType) => {
      const resolved = await resolveHeartbeatDeliveryTargetWithSessionRoute({
        entry: session({ lastChannel: "alpha", lastTo: storedTo, chatType: storedType }),
        heartbeat: { target: "last", directPolicy: "block" },
        turnSource: { channel: "alpha", to: eventTo },
      });
      expect(resolved.channel).toBe(expectedChannel);
      expect(resolved.chatType).toBe(expectedType);
      if (expectedChannel === "none") {
        expect(resolved.reason).toBe("dm-blocked");
        expect(resolved.to).toBeUndefined();
      } else {
        expect(resolved.to).toBe(eventTo);
      }
    },
  );
});

describe("resolveSessionDeliveryTarget — cross-channel reply guard (#24152)", () => {
  const topicSession = session({ lastChannel: "forum", lastTo: "room:ops", lastThreadId: 1122 });
  const changedSession = session({ lastChannel: "beta", lastTo: "wrong-room" });
  it.each([
    [
      "explicit channel overrides turn source",
      changedSession,
      { channel: "alpha", to: "room-one" },
      { channel: "forum" },
      { requestedChannel: "forum", explicitTo: "room:ops" },
    ],
    [
      "turn source owns account and thread",
      { ...changedSession, lastAccountId: "wrong-account", lastThreadId: 999 },
      { channel: "forum", to: "room:ops", accountId: "bot-123", threadId: 42 },
      { channel: "forum", to: "room:ops", accountId: "bot-123", threadId: 42 },
    ],
    [
      "turn source channel suppresses stale metadata",
      { ...changedSession, lastAccountId: "wrong-account", lastThreadId: "thread-1" },
      { channel: "alpha" },
      {
        channel: "alpha",
        to: undefined,
        accountId: undefined,
        threadId: undefined,
        lastTo: undefined,
        lastAccountId: undefined,
        lastThreadId: undefined,
      },
    ],
    [
      "same conversation inherits session topic",
      { ...topicSession, lastAccountId: "work" },
      { channel: "forum", to: "room:ops", accountId: "work" },
      {
        channel: "forum",
        to: "room:ops",
        accountId: "work",
        threadId: 1122,
        threadIdSource: "session",
      },
    ],
    [
      "different account cannot inherit session topic",
      { ...topicSession, lastAccountId: "personal" },
      { channel: "forum", to: "room:ops", accountId: "work" },
      {
        accountId: "work",
        threadId: undefined,
        threadIdSource: undefined,
        lastThreadId: undefined,
      },
    ],
    [
      "bare stored destination does not match topic-scoped turn",
      topicSession,
      { channel: "forum", to: "forum:room:ops:topic:1122" },
      { channel: "forum", to: "forum:room:ops:topic:1122", threadId: undefined },
    ],
    [
      "different destination cannot inherit session thread",
      topicSession,
      { channel: "forum", to: "room:other" },
      { channel: "forum", to: "room:other", threadId: undefined },
    ],
  ] satisfies SessionTargetCase[])("%s", (_name, entry, source, expected, explicit) => {
    expect(
      resolveSessionDeliveryTarget({
        requestedChannel: "last",
        entry,
        turnSourceChannel: source.channel,
        turnSourceTo: source.to,
        turnSourceAccountId: source.accountId,
        turnSourceThreadId: source.threadId,
        ...explicit,
      }),
    ).toMatchObject(expected);
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
