// Covers outbound direct target resolution and explicit proactive delivery policy.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelPlugin } from "../../channels/plugins/types.public.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { ChannelRouteRef } from "../../plugin-sdk/channel-route.js";
import { getActivePluginRegistry, setActivePluginRegistry } from "../../plugins/runtime.js";
import { setActiveDegradedSecretOwners } from "../../secrets/runtime-degraded-state.js";
import type { DeliveryContext } from "../../utils/delivery-context.types.js";
import { normalizeLegacySessionEntryDelivery } from "../state-migrations.legacy-session-store.js";
import {
  hasResolvableProactiveOwnerRoute,
  resolveProactiveDeliveryTarget as resolveCanonicalProactiveDeliveryTarget,
  resolveProactiveDeliveryTargetWithSessionRoute as resolveCanonicalProactiveDeliveryTargetWithSessionRoute,
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

function resolveProactiveDeliveryTarget(
  params: Omit<Parameters<typeof resolveCanonicalProactiveDeliveryTarget>[0], "entry"> & {
    entry?: LegacyDeliveryFixture;
  },
) {
  return resolveCanonicalProactiveDeliveryTarget({
    ...params,
    entry: params.entry ? normalizeLegacySessionEntryDelivery(params.entry) : undefined,
  });
}

async function resolveProactiveDeliveryTargetWithSessionRoute(
  params: Omit<
    Parameters<typeof resolveCanonicalProactiveDeliveryTargetWithSessionRoute>[0],
    "entry"
  > & { entry?: LegacyDeliveryFixture },
) {
  return await resolveCanonicalProactiveDeliveryTargetWithSessionRoute({
    ...params,
    entry: params.entry ? normalizeLegacySessionEntryDelivery(params.entry) : undefined,
  });
}

function createOwnerAllowlistTargetTestPlugin(params: {
  id: ChannelPlugin["id"];
  label: string;
  ownerId: string;
  inferTargetChatType?: NonNullable<ChannelPlugin["messaging"]>["inferTargetChatType"];
}): ChannelPlugin {
  const plugin = createTestChannelPlugin({
    id: params.id,
    label: params.label,
    outbound: {
      deliveryMode: "direct",
      resolveTarget: ({ to }) =>
        to
          ? { ok: true as const, to: to.trim() }
          : { ok: false as const, error: new Error("target required") },
    },
    messaging: {
      ...(params.inferTargetChatType ? { inferTargetChatType: params.inferTargetChatType } : {}),
      // Real channel plugins declare their id as a target prefix; prefixed
      // configured-owner entries rely on it to bind to the right channel.
      targetPrefixes: [String(params.id)],
      targetResolver: { looksLikeId: () => true },
    },
  });
  plugin.config = { ...plugin.config, resolveAllowFrom: () => [params.ownerId] };
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

type SessionTargetCase = {
  name: string;
  input: Parameters<typeof resolveSessionDeliveryTarget>[0];
  expected: Partial<SessionDeliveryTarget>;
};

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
    ).toEqual({
      ok: true,
      to: "room-one",
    });
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

  it("never reuses a group route for implicit owner delivery", async () => {
    const forum = createForumTargetTestPlugin();
    forum.config = {
      ...forum.config,
      resolveAllowFrom: () => ["dm:operator"],
    };
    setActivePluginRegistry(createTargetsTestRegistry([forum]));

    const resolved = await resolveProactiveDeliveryTarget({
      cfg: { channels: { forum: { allowFrom: ["dm:operator"] } } } as OpenClawConfig,
      entry: {
        sessionId: "sess-owner-group",
        updatedAt: 1,
        lastChannel: "forum",
        lastTo: "room:ops",
        chatType: "group",
      },
      policy: { to: "group:wrong" },
    });

    expect(resolved.channel).toBe("forum");
    expect(resolved.to).toBe("dm:operator");
    expect(resolved.chatType).toBe("direct");
  });

  it.each([
    {
      name: "wildcard-only owners fail closed",
      channel: "alpha",
      allowFrom: ["", "*"],
      configAllowFrom: ["*"],
      configuredOwners: ["", "*"],
      implicit: true,
      expected: { channel: "none", reason: "no-route" },
    },
    {
      name: "channel-scoped wildcard owners fail closed",
      channel: "telegram",
      allowFrom: ["telegram:*"],
      configuredOwners: ["telegram:*"],
      classify: () => "direct",
      expected: { channel: "none", reason: "no-route" },
    },
  ] satisfies Array<{
    name: string;
    channel: string;
    allowFrom: string[];
    configAllowFrom?: string[];
    configuredOwners?: string[];
    classify?: NonNullable<ChannelPlugin["messaging"]>["inferTargetChatType"];
    implicit?: boolean;
    expected: { channel: string; to?: string; chatType?: string; reason?: string };
  }>)(
    "selects proactive owners: $name",
    async ({
      channel,
      allowFrom,
      configAllowFrom,
      configuredOwners,
      classify,
      implicit,
      expected,
    }) => {
      const plugin =
        channel === "alpha"
          ? createGenericTargetTestPlugin("alpha", "Alpha")
          : createOwnerAllowlistTargetTestPlugin({
              id: channel,
              label: "Telegram",
              ownerId: allowFrom[0] ?? "",
              inferTargetChatType: classify,
            });
      plugin.config = { ...plugin.config, resolveAllowFrom: () => allowFrom };
      setActivePluginRegistry(createTargetsTestRegistry([plugin]));
      const resolved = await resolveProactiveDeliveryTarget({
        cfg: {
          ...(configuredOwners ? { commands: { ownerAllowFrom: configuredOwners } } : {}),
          channels: { [channel]: { allowFrom: configAllowFrom ?? allowFrom } },
        },
        policy: implicit ? undefined : { target: "owner" },
      });
      expect(resolved).toMatchObject(expected);
    },
  );

  it.each(["cold", "disabled"] as const)(
    "keeps proactive owner discovery usable when an account is %s",
    async (state) => {
      const alpha = createOwnerAllowlistTargetTestPlugin({
        id: "alpha",
        label: "Alpha",
        ownerId: "user:alpha-owner",
        inferTargetChatType: () => "direct",
      });
      const beta = createOwnerAllowlistTargetTestPlugin({
        id: "beta",
        label: "Beta",
        ownerId: "user:beta-owner",
        inferTargetChatType: () => "direct",
      });
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
      setActivePluginRegistry(createTargetsTestRegistry([alpha, beta]));
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

      expect(await hasResolvableProactiveOwnerRoute({ cfg, policy: { accountId: "work" } })).toBe(
        true,
      );
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
    const telegram = createOwnerAllowlistTargetTestPlugin({
      id: "telegram",
      label: "Telegram",
      ownerId: "123456789",
      inferTargetChatType: ({ to }) => (/^\d+$/.test(to) ? "direct" : undefined),
    });
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
    setActivePluginRegistry(createTargetsTestRegistry([telegram]));

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
    expect(await hasResolvableProactiveOwnerRoute({ cfg: unresolvedCfg })).toBe(false);

    // Once the read-only resolution contract materializes the credential, the
    // configured owner route resolves without any other config change (#137217).
    const resolvedCfg: OpenClawConfig = {
      commands: { ownerAllowFrom: ["telegram:123456789"] },
      channels: { telegram: { enabled: true, botToken: "8905123456:AAF-example-bDTs" } },
    };
    expect(await hasResolvableProactiveOwnerRoute({ cfg: resolvedCfg })).toBe(true);
  });

  it("reuses an exact direct owner route with its account and thread", async () => {
    const alpha = createGenericTargetTestPlugin("alpha", "Alpha");
    setActivePluginRegistry(createTargetsTestRegistry([alpha]));

    const resolved = await resolveProactiveDeliveryTarget({
      cfg: { commands: { ownerAllowFrom: ["alpha:user:owner"] } },
      entry: {
        sessionId: "sess-owner-direct",
        updatedAt: 1,
        lastChannel: "alpha",
        lastTo: "user:owner",
        lastAccountId: "work",
        lastThreadId: "thread-7",
        chatType: "direct",
      },
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
    setActivePluginRegistry(createTargetsTestRegistry([]));
    const resolved = await resolveProactiveDeliveryTarget({
      cfg: {},
      entry: session({ lastChannel: "forum" }),
      policy: { target: "last", accountId: "configured-account" },
    });
    expect(resolved.channel).toBe("none");
    expect(resolved.reason).toBe("no-route");
    expect(mocks.resolveOutboundChannelPlugin).not.toHaveBeenCalled();
  });

  it("allows proactive delivery to plugin-classified direct chats by default", async () => {
    const resolved = await resolveProactiveDeliveryTarget({
      cfg: {},
      entry: session({ lastChannel: "forum", lastTo: "dm:one" }),
      policy: { target: "last" },
    });
    expect(resolved.channel).toBe("forum");
    expect(resolved.to).toBe("dm:one");
    expect(resolved.reason).toBeUndefined();
    expect(resolved.threadId).toBeUndefined();
  });

  it("preserves the canonical proactive target after route resolution", async () => {
    const cfg: OpenClawConfig = {};
    const proactive = { target: "forum", to: "room:ops:topic:1008013" };
    const resolved = await resolveProactiveDeliveryTargetWithSessionRoute({
      cfg,
      agentId: "main",
      policy: proactive,
    });
    expect(resolved.channel).toBe("forum");
    expect(resolved.to).toBe("room:ops");
    expect(resolved.threadId).toBe(1008013);
    expect(mocks.resolveOutboundChannelPlugin).toHaveBeenCalledWith({
      channel: "forum",
      cfg,
      agentId: "main",
      allowBootstrap: true,
    });
  });

  it("upgrades an owner-route setup shell with the selected agent runtime", async () => {
    const runtime = createOwnerAllowlistTargetTestPlugin({
      id: "forum",
      label: "Forum",
      ownerId: "user:ops",
      inferTargetChatType: () => "direct",
    });
    const setup = { ...runtime, outbound: undefined };
    setActivePluginRegistry(createTargetsTestRegistry([setup]));
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

    expect(resolved.channel).toBe("forum");
    expect(resolved.to).toBe("user:ops");
    expect(mocks.resolveOutboundChannelPlugin).toHaveBeenCalledWith({
      channel: "forum",
      cfg,
      agentId: "ops",
      allowBootstrap: true,
    });
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
    setActivePluginRegistry(createTargetsTestRegistry([]));
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
    expect(
      mocks.resolveOutboundChannelPlugin.mock.calls.filter(
        ([params]) => params.allowBootstrap === true,
      ),
    ).toHaveLength(1);
  });

  it("uses explicit direct policy without inheriting retired heartbeat defaults", async () => {
    const alpha = createGenericTargetTestPlugin("alpha", "Alpha");
    const routedAlpha: ChannelPlugin = {
      ...alpha,
      messaging: {
        ...alpha.messaging,
        resolveOutboundSessionRoute: () => ({
          sessionKey: "main:alpha:user:u123",
          baseSessionKey: "main:alpha:user:u123",
          peer: { kind: "direct", id: "u123" },
          chatType: "direct",
          from: "alpha:u123",
          to: "user:u123",
        }),
      },
    };
    setActivePluginRegistry(createTargetsTestRegistry([routedAlpha]));
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
    expect(resolved.channel).toBe("none");
    expect(resolved.reason).toBe("dm-blocked");
  });

  it("uses resolved target kind before applying proactive directPolicy to routed handles", async () => {
    setActivePluginRegistry(
      createTargetsTestRegistry([
        createTestChannelPlugin({
          id: "telegram",
          label: "Telegram",
          outbound: {
            deliveryMode: "direct",
            resolveTarget: ({ to }) =>
              to
                ? { ok: true as const, to: to.trim() }
                : { ok: false as const, error: new Error("target required") },
          },
          messaging: {
            targetPrefixes: ["telegram"],
            inferTargetChatType: () => "group",
            targetResolver: {
              resolveTarget: async ({ normalized }) => ({
                to: normalized,
                kind: "group",
                source: "directory",
              }),
            },
            resolveOutboundSessionRoute: ({ target, resolvedTarget }) => {
              const isGroup = resolvedTarget?.kind === "group";
              return {
                sessionKey: `main:telegram:${isGroup ? "group" : "user"}:${target}`,
                baseSessionKey: `main:telegram:${isGroup ? "group" : "user"}:${target}`,
                peer: { kind: isGroup ? "group" : "direct", id: target },
                chatType: isGroup ? "group" : "direct",
                from: isGroup ? `telegram:group:${target}` : `telegram:${target}`,
                to: target,
              };
            },
          },
        }),
      ]),
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

    expect(resolved.channel).toBe("telegram");
    expect(resolved.to).toBe("@public_group");
    expect(resolved.chatType).toBe("group");
  });

  it("rejects an owner destination whose canonical session route is a group", async () => {
    const alpha = createTestChannelPlugin({
      id: "alpha",
      label: "Alpha",
      outbound: {
        deliveryMode: "direct",
        resolveTarget: ({ to }) =>
          to
            ? { ok: true as const, to: to.trim() }
            : { ok: false as const, error: new Error("target required") },
      },
      messaging: {
        inferTargetChatType: () => "direct",
        targetResolver: {
          resolveTarget: async ({ normalized }) => ({
            to: normalized,
            kind: "user",
            source: "directory",
          }),
        },
        resolveOutboundSessionRoute: ({ target }) => ({
          sessionKey: `main:alpha:group:${target}`,
          baseSessionKey: `main:alpha:group:${target}`,
          peer: { kind: "group", id: target },
          chatType: "group",
          from: `alpha:group:${target}`,
          to: target,
        }),
      },
    });
    alpha.config = { ...alpha.config, resolveAllowFrom: () => ["operator"] };
    setActivePluginRegistry(createTargetsTestRegistry([alpha]));

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
    const plugin = createOwnerAllowlistTargetTestPlugin({
      id,
      label: id,
      ownerId,
      inferTargetChatType: classify,
    });
    setActivePluginRegistry(createTargetsTestRegistry([plugin]));
    const resolved = await resolveProactiveDeliveryTargetWithSessionRoute({
      cfg: { channels: { [id]: { allowFrom: [ownerId] } } },
      agentId: "main",
      policy: { target: "owner" },
    });
    expect(resolved).toMatchObject({ channel: "none", reason: "no-route" });
  });

  it("prefers a prefixed configured owner on a later channel over session-channel allowFrom", async () => {
    const slack = createOwnerAllowlistTargetTestPlugin({
      id: "slack",
      label: "Slack",
      ownerId: "user:slack-local",
      inferTargetChatType: ({ to }) => (/^user:/i.test(to) ? "direct" : undefined),
    });
    const telegram = createOwnerAllowlistTargetTestPlugin({
      id: "telegram",
      label: "Telegram",
      ownerId: "999",
      inferTargetChatType: ({ to }) => (/^\d+$/.test(to) ? "direct" : undefined),
    });
    setActivePluginRegistry(createTargetsTestRegistry([slack, telegram]));

    const resolved = await resolveProactiveDeliveryTarget({
      cfg: {
        commands: { ownerAllowFrom: ["telegram:456"] },
        channels: {
          slack: { allowFrom: ["user:slack-local"] },
          telegram: { allowFrom: ["999"] },
        },
      } as OpenClawConfig,
      entry: {
        sessionId: "sess-slack-first",
        updatedAt: 1,
        lastChannel: "slack",
        lastTo: "user:someone",
        chatType: "direct",
      },
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
    const whatsapp = createOwnerAllowlistTargetTestPlugin({
      id: "whatsapp",
      label: "WhatsApp",
      ownerId: "+15555550166",
      inferTargetChatType,
    });
    setActivePluginRegistry(createTargetsTestRegistry([whatsapp]));
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
    expect(inferTargetChatType).toHaveBeenCalledWith({ to: "+15555550166" });
  });

  it("blocks direct targets from prepared external target resolvers without route hooks", async () => {
    const external = createTestChannelPlugin({
      id: "external-channel",
      label: "External",
      outbound: {
        deliveryMode: "direct",
        resolveTarget: ({ to }) =>
          to
            ? { ok: true as const, to: to.trim() }
            : { ok: false as const, error: new Error("target required") },
      },
      messaging: {
        targetResolver: {
          resolveTarget: async ({ normalized }) => ({
            to: normalized,
            kind: "user",
            source: "directory",
          }),
        },
      },
    });
    setActivePluginRegistry(createTargetsTestRegistry([]));
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

    const resolved = await resolveProactiveDeliveryTargetWithSessionRoute({
      cfg: {},
      agentId: "main",
      policy: {
        target: "external-channel",
        to: "person-123",
        directPolicy: "block",
      },
    });

    expect(resolved.channel).toBe("none");
    expect(resolved.reason).toBe("dm-blocked");
  });

  it("uses an activation-aware infer-only plugin for proactive direct policy", async () => {
    const external = createTestChannelPlugin({
      id: "external-channel",
      label: "External",
      outbound: {
        deliveryMode: "direct",
        sendText: vi.fn(),
        resolveTarget: ({ to }) =>
          to
            ? { ok: true as const, to: to.trim() }
            : { ok: false as const, error: new Error("target required") },
      },
      messaging: {
        inferTargetChatType: () => "direct",
      },
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

    const resolved = await resolveProactiveDeliveryTarget({
      cfg: {},
      policy: {
        target: "external-channel",
        to: "person-123",
        directPolicy: "block",
      },
    });

    expect(resolved.channel).toBe("none");
    expect(resolved.reason).toBe("dm-blocked");
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
  ])("resolves proactive reserved literals: $name", async ({ groups, expected }) => {
    const listGroups = vi.fn().mockResolvedValue(groups);
    const listGroupsLive = vi.fn().mockResolvedValue([]);
    setActivePluginRegistry(
      createTargetsTestRegistry([
        {
          ...createTestChannelPlugin({
            id: "telegram",
            label: "Telegram",
            outbound: {
              deliveryMode: "direct",
              resolveTarget: ({ to }) =>
                to
                  ? { ok: true, to: to.trim() }
                  : { ok: false, error: new Error("target required") },
            },
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
        },
      ]),
    );
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
    setActivePluginRegistry(
      createTargetsTestRegistry([
        {
          ...alpha,
          messaging: {
            ...alpha.messaging,
            inferTargetChatType: () => "group",
            resolveOutboundSessionRoute: () => {
              throw new Error("route lookup failed");
            },
          },
        },
      ]),
    );

    const resolved = await resolveProactiveDeliveryTargetWithSessionRoute({
      cfg: {},
      agentId: "main",
      entry: {
        sessionId: "sess-proactive-route-failure",
        updatedAt: 1,
        lastChannel: "alpha",
        lastTo: "group:ops",
      },
      policy: {
        target: "last",
      },
    });

    expect(resolved.channel).toBe("alpha");
    expect(resolved.to).toBe("group:ops");
    expect(resolved.chatType).toBe("group");
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
    expect(resolved.channel).toBe("forum");
    expect(resolved.to).toBe(to);
    expect(resolved.threadId).toBe(threadId);
  });

  it.each([
    {
      name: "moved direct session does not block the event group",
      storedTo: "user:operator",
      storedType: "direct",
      eventTo: "group:ops",
      expectedChannel: "alpha",
      expectedType: "group",
    },
    {
      name: "moved group session does not allow the event direct chat",
      storedTo: "group:ops",
      storedType: "group",
      eventTo: "user:operator",
      expectedChannel: "none",
      expectedType: undefined,
    },
    {
      name: "same opaque direct conversation retains its hint",
      storedTo: "opaque-dm",
      storedType: "direct",
      eventTo: "opaque-dm",
      expectedChannel: "none",
      expectedType: undefined,
    },
  ] as const)(
    "qualifies proactive chat type by the selected conversation: $name",
    async ({ storedTo, storedType, eventTo, expectedChannel, expectedType }) => {
      const resolved = await resolveProactiveDeliveryTargetWithSessionRoute({
        cfg: {},
        agentId: "main",
        entry: {
          sessionId: "chat-type-owner",
          updatedAt: 1,
          lastChannel: "alpha",
          lastTo: storedTo,
          chatType: storedType,
        },
        policy: {
          target: eventTo === storedTo ? "last" : "alpha",
          to: eventTo === storedTo ? undefined : eventTo,
          directPolicy: "block",
        },
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
        entry: { ...changedSession, lastAccountId: "wrong-account", lastThreadId: 999 },
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
        entry: { ...changedSession, lastAccountId: "wrong-account", lastThreadId: "thread-1" },
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
        entry: { ...topicSession, lastAccountId: "work" },
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
        entry: { ...topicSession, lastAccountId: "personal" },
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
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
