// Covers outbound direct target resolution, heartbeat target derivation,
// heartbeat sender context, and route-aware heartbeat refinements.
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

function resolveHeartbeatDeliveryTarget(
  params: Omit<Parameters<typeof resolveCanonicalHeartbeatDeliveryTarget>[0], "entry"> & {
    entry?: LegacyDeliveryFixture;
  },
) {
  return resolveCanonicalHeartbeatDeliveryTarget({
    ...params,
    entry: params.entry ? normalizeLegacySessionEntryDelivery(params.entry) : undefined,
  });
}

async function resolveHeartbeatDeliveryTargetWithSessionRoute(
  params: Omit<
    Parameters<typeof resolveCanonicalHeartbeatDeliveryTargetWithSessionRoute>[0],
    "entry"
  > & { entry?: LegacyDeliveryFixture },
) {
  return await resolveCanonicalHeartbeatDeliveryTargetWithSessionRoute({
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

  it("passes bootstrap opt-in and overrides the plugin default with an explicit target", async () => {
    const cfg: OpenClawConfig = {
      channels: { alpha: { defaultTo: "Alpha:Room One", allowFrom: ["*"] } },
    };
    expect(
      await resolveOutboundTarget({
        channel: "alpha",
        to: "Alpha:Override Room",
        cfg,
        mode: "explicit",
        allowBootstrap: true,
      }),
    ).toEqual({ ok: true, to: "override-room" });
    expect(mocks.resolveOutboundChannelPlugin).toHaveBeenCalledWith({
      channel: "alpha",
      cfg,
      allowBootstrap: true,
    });
  });

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
  it.each([
    {
      name: "normalized last route",
      storedChannel: " alpha ",
      storedTo: " Room One ",
      accountId: " acct-1 ",
      input: {},
      channel: "alpha",
      to: "Room One",
      lastTo: "Room One",
      account: "acct-1",
    },
    {
      name: "channel mismatch",
      storedChannel: "alpha",
      storedTo: "room-one",
      input: { requestedChannel: "beta" },
      channel: "beta",
      to: undefined,
      lastTo: "room-one",
    },
    {
      name: "allowed channel mismatch",
      storedChannel: "alpha",
      storedTo: "room-one",
      input: { requestedChannel: "beta", allowMismatchedLastTo: true },
      channel: "beta",
      to: "room-one",
      lastTo: "room-one",
    },
    {
      name: "unsupported channel fallback",
      storedChannel: "alpha",
      storedTo: "room-one",
      input: { requestedChannel: "webchat", fallbackChannel: "beta" },
      channel: "beta",
      to: undefined,
      lastTo: "room-one",
    },
  ])(
    "selects the $name",
    ({ storedChannel, storedTo, accountId, input, channel, to, lastTo, account }) => {
      const resolved = resolveSessionDeliveryTarget({
        entry: session({ lastChannel: storedChannel, lastTo: storedTo, lastAccountId: accountId }),
        requestedChannel: "last",
        ...input,
      });
      expect(resolved).toEqual({
        channel,
        to,
        accountId: account,
        threadId: undefined,
        mode: "implicit",
        lastChannel: "alpha",
        lastTo,
        lastAccountId: accountId ? "acct-1" : undefined,
        lastThreadId: undefined,
      });
    },
  );

  it.each([
    { name: "provider prefix", to: "beta:room-two", channel: "beta" },
    { name: "target-kind prefix", to: "channel:room-two", channel: "alpha" },
  ])("selects explicit $name before session fallback", ({ to, channel }) => {
    const resolved = resolveSessionDeliveryTarget({
      entry: session({ lastChannel: "alpha", lastTo: "room-one" }),
      requestedChannel: "last",
      explicitTo: to,
    });
    expect(resolved).toMatchObject({ channel, to, lastChannel: "alpha" });
  });

  it.each([
    { name: "explicit thread", input: { explicitThreadId: 42 }, expected: 42 },
    { name: "session thread", input: {}, expected: 999 },
    { name: "heartbeat drops inherited thread", input: { mode: "heartbeat" }, expected: undefined },
    {
      name: "heartbeat explicit thread",
      input: { mode: "heartbeat", explicitThreadId: 42 },
      expected: 42,
    },
  ] satisfies Array<{
    name: string;
    input: Omit<Parameters<typeof resolveSessionDeliveryTarget>[0], "entry">;
    expected: number | undefined;
  }>)("resolves $name", ({ input, expected }) => {
    const resolved = resolveSessionDeliveryTarget({
      entry: session({ lastChannel: "forum", lastTo: "room:ops", lastThreadId: 999 }),
      requestedChannel: "last",
      ...input,
    });
    expect(resolved).toMatchObject({ channel: "forum", to: "room:ops", threadId: expected });
  });

  it.each([
    {
      name: "forum route",
      storedChannel: "forum",
      storedTo: "room:ops",
      requestedChannel: "last",
      to: "room:ops:topic:1008013",
    },
    {
      name: "missing stored destination",
      storedChannel: "forum",
      storedTo: undefined,
      requestedChannel: "last",
      to: "room:ops:topic:1008013",
    },
    {
      name: "other channel",
      storedChannel: "alpha",
      storedTo: "room-one",
      requestedChannel: "last",
      to: "room-one:topic:999",
    },
    {
      name: "different requested channel",
      storedChannel: "forum",
      storedTo: "room:ops",
      requestedChannel: "alpha",
      to: "room-one:topic:999",
    },
    {
      name: "unavailable registry",
      storedChannel: "forum",
      storedTo: "room:ops",
      requestedChannel: "last",
      to: "room:ops:topic:1008013",
      emptyRegistry: true,
    },
    {
      name: "explicit thread override",
      storedChannel: "forum",
      storedTo: "room:ops",
      requestedChannel: "last",
      to: "room:ops:topic:1008013",
      threadId: 42,
    },
  ])(
    "keeps plugin-owned targets raw with $name",
    ({ storedChannel, storedTo, requestedChannel, to, emptyRegistry, threadId }) => {
      if (emptyRegistry) {
        setActivePluginRegistry(createTargetsTestRegistry([]));
      }
      const resolved = resolveSessionDeliveryTarget({
        entry: session({ lastChannel: storedChannel, lastTo: storedTo }),
        requestedChannel,
        explicitTo: to,
        explicitThreadId: threadId,
      });
      expect(resolved.to).toBe(to);
      expect(resolved.threadId).toBe(threadId);
    },
  );

  it.each([
    {
      name: "implicit origin",
      target: undefined,
      entry: session({ lastChannel: "alpha", lastTo: "chat:stale" }),
      turnSource: { channel: "beta", to: "chat:event", threadId: "77" },
      expected: { channel: "beta", to: "chat:event", threadId: "77" },
    },
    {
      name: "explicit suppression",
      target: "none",
      entry: session({ lastChannel: "alpha", lastTo: "chat:one" }),
      turnSource: { channel: "alpha", to: "chat:one" },
      expected: { channel: "none", reason: "target-none" },
    },
    {
      name: "implicit group origin",
      target: undefined,
      turnSource: { channel: "beta", to: "group:event", threadId: "77" },
      expected: { channel: "beta", to: "group:event", threadId: "77" },
    },
    {
      name: "owner group origin",
      target: "owner",
      turnSource: { channel: "beta", to: "group:event", threadId: "77" },
      expected: { channel: "beta", to: "group:event", threadId: "77" },
    },
  ])(
    "honors heartbeat event routing for $name",
    async ({ target, entry, turnSource, expected }) => {
      const resolved = await resolveHeartbeatDeliveryTarget({
        cfg: {},
        entry,
        heartbeat: target ? { target } : undefined,
        turnSource,
      });
      expect(resolved).toMatchObject(expected);
    },
  );

  it("delivers to the last session route when explicitly configured", async () => {
    const resolved = await resolveHeartbeatDeliveryTarget({
      cfg: {},
      entry: {
        sessionId: "sess-no-config-no-origin",
        updatedAt: 1,
        lastChannel: "alpha",
        lastTo: "chat:one",
      },
      heartbeat: { target: "last" },
    });
    expect(resolved.channel).toBe("alpha");
    expect(resolved.to).toBe("chat:one");
  });

  it("never reuses a group route for implicit owner delivery", async () => {
    const forum = createForumTargetTestPlugin();
    forum.config = {
      ...forum.config,
      resolveAllowFrom: () => ["dm:operator"],
    };
    setActivePluginRegistry(createTargetsTestRegistry([forum]));

    const resolved = await resolveHeartbeatDeliveryTarget({
      cfg: { channels: { forum: { allowFrom: ["dm:operator"] } } } as OpenClawConfig,
      entry: {
        sessionId: "sess-owner-group",
        updatedAt: 1,
        lastChannel: "forum",
        lastTo: "room:ops",
        chatType: "group",
      },
    });

    expect(resolved.channel).toBe("forum");
    expect(resolved.to).toBe("dm:operator");
    expect(resolved.chatType).toBe("direct");
  });

  it.each([
    {
      name: "configured owner outranks channel owner",
      channel: "alpha",
      allowFrom: ["user:channel-owner"],
      configuredOwners: ["user:global-owner"],
      expected: { channel: "alpha", to: "user:global-owner", chatType: "direct" },
    },
    {
      name: "first compatible configured owner",
      channel: "telegram",
      allowFrom: ["789"],
      configuredOwners: ["discord:123", "456"],
      classify: ({ to }) => (/^\d+$/.test(to) ? "direct" : undefined),
      expected: { channel: "telegram", to: "456", chatType: "direct" },
    },
    {
      name: "channel owner fallback",
      channel: "alpha",
      allowFrom: ["", "*", "user:channel-owner"],
      configAllowFrom: ["user:channel-owner"],
      expected: { channel: "alpha", to: "user:channel-owner", chatType: "direct" },
    },
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
    "selects heartbeat owners: $name",
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
      const resolved = await resolveHeartbeatDeliveryTarget({
        cfg: {
          ...(configuredOwners ? { commands: { ownerAllowFrom: configuredOwners } } : {}),
          channels: { [channel]: { allowFrom: configAllowFrom ?? allowFrom } },
        },
        heartbeat: implicit ? undefined : { target: "owner" },
      });
      expect(resolved).toMatchObject(expected);
    },
  );

  it("picks the first configured channel in deterministic registry order", async () => {
    const alpha = createGenericTargetTestPlugin("alpha", "Alpha");
    alpha.config = { ...alpha.config, resolveAllowFrom: () => ["user:alpha-owner"] };
    const beta = createGenericTargetTestPlugin("beta", "Beta");
    beta.config = { ...beta.config, resolveAllowFrom: () => ["user:beta-owner"] };
    setActivePluginRegistry(createTargetsTestRegistry([beta, alpha]));

    const resolved = await resolveHeartbeatDeliveryTarget({
      cfg: {
        channels: {
          alpha: { allowFrom: ["user:alpha-owner"] },
          beta: { allowFrom: ["user:beta-owner"] },
        },
      } as OpenClawConfig,
    });

    expect(resolved).toMatchObject({ channel: "alpha", to: "user:alpha-owner" });
  });

  it.each(["cold", "disabled", "inspection-unavailable", "stale"] as const)(
    "keeps heartbeat owner discovery usable when an account is %s",
    async (state) => {
      const unavailable = state !== "stale";
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
        if (unavailable) {
          throw new Error("unavailable credential must not resolve for owner discovery");
        }
        return ["user:alpha-owner"];
      });
      alpha.config = {
        ...alpha.config,
        listAccountIds: () => ["work"],
        inspectAccount: () => ({
          enabled: state !== "disabled",
          configured: true,
          tokenStatus: state === "inspection-unavailable" ? "configured_unavailable" : "available",
        }),
        resolveAllowFrom,
      };
      beta.config.listAccountIds = () => ["work"];
      setActivePluginRegistry(createTargetsTestRegistry([alpha, beta]));
      if (state === "cold" || state === "stale") {
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
      ).toMatchObject({
        channel: unavailable ? "beta" : "alpha",
        accountId: "work",
        to: unavailable ? "user:beta-owner" : "user:alpha-owner",
      });
      if (unavailable) {
        expect(resolveAllowFrom).not.toHaveBeenCalled();
      } else {
        expect(resolveAllowFrom).toHaveBeenCalled();
      }
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
    setActivePluginRegistry(createTargetsTestRegistry([alpha]));

    const resolved = await resolveHeartbeatDeliveryTarget({
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

  it.each([undefined, "owner"])("ignores heartbeat.to for target %s", async (target) => {
    const alpha = createGenericTargetTestPlugin("alpha", "Alpha");
    alpha.config = { ...alpha.config, resolveAllowFrom: () => ["user:owner"] };
    setActivePluginRegistry(createTargetsTestRegistry([alpha]));
    const heartbeat = { ...(target ? { target } : {}), to: "group:wrong" };

    const resolved = await resolveHeartbeatDeliveryTarget({
      cfg: { channels: { alpha: { allowFrom: ["user:owner"] } } } as OpenClawConfig,
      heartbeat,
    });

    expect(resolved).toMatchObject({ channel: "alpha", to: "user:owner" });
  });

  it.each([
    {
      name: "implicit owner without a session route",
      target: undefined,
      accountId: undefined,
      lastChannel: undefined,
      emptyRegistry: false,
    },
    {
      name: "last route without a concrete target",
      target: "last",
      accountId: "configured-account",
      lastChannel: "forum",
      emptyRegistry: true,
    },
  ])(
    "reports no heartbeat route for $name",
    async ({ target, accountId, lastChannel, emptyRegistry }) => {
      if (emptyRegistry) {
        setActivePluginRegistry(createTargetsTestRegistry([]));
      }
      const resolved = await resolveHeartbeatDeliveryTarget({
        cfg: {},
        entry: session({ lastChannel }),
        heartbeat: target ? { target, accountId } : undefined,
      });
      expect(resolved.channel).toBe("none");
      expect(resolved.reason).toBe("no-route");
      if (emptyRegistry) {
        expect(mocks.resolveOutboundChannelPlugin).not.toHaveBeenCalled();
      }
    },
  );

  const expectHeartbeatTarget = async (params: {
    name: string;
    entry: LegacyDeliveryFixture;
    directPolicy?: "allow" | "block";
    expectedChannel: string;
    expectedTo?: string;
    expectedReason?: string;
    expectedThreadId?: string | number;
  }) => {
    const resolved = await resolveHeartbeatDeliveryTarget({
      cfg: {},
      entry: normalizeLegacySessionEntryDelivery(params.entry),
      heartbeat: { target: "last", directPolicy: params.directPolicy },
    });
    expect(resolved.channel, params.name).toBe(params.expectedChannel);
    expect(resolved.to, params.name).toBe(params.expectedTo);
    expect(resolved.reason, params.name).toBe(params.expectedReason);
    expect(resolved.threadId, params.name).toBe(params.expectedThreadId);
  };

  it.each([
    {
      name: "allows heartbeat delivery to direct targets by default and drops inherited thread ids",
      entry: {
        sessionId: "sess-heartbeat-alpha-direct",
        updatedAt: 1,
        lastChannel: "alpha",
        lastTo: "user:one",
        lastThreadId: "thread-1",
      },
      expectedChannel: "alpha",
      expectedTo: "user:one",
    },
    {
      name: "blocks heartbeat delivery to direct targets when directPolicy is block",
      entry: {
        sessionId: "sess-heartbeat-alpha-direct-blocked",
        updatedAt: 1,
        lastChannel: "alpha",
        lastTo: "user:one",
        lastThreadId: "thread-1",
      },
      directPolicy: "block" as const,
      expectedChannel: "none",
      expectedReason: "dm-blocked",
    },
    {
      name: "allows heartbeat delivery to plugin-classified direct chats by default",
      entry: {
        sessionId: "sess-heartbeat-forum-direct",
        updatedAt: 1,
        lastChannel: "forum",
        lastTo: "dm:one",
      },
      expectedChannel: "forum",
      expectedTo: "dm:one",
    },
    {
      name: "blocks heartbeat delivery to plugin-classified direct chats when directPolicy is block",
      entry: {
        sessionId: "sess-heartbeat-forum-direct-blocked",
        updatedAt: 1,
        lastChannel: "forum",
        lastTo: "dm:one",
      },
      directPolicy: "block" as const,
      expectedChannel: "none",
      expectedReason: "dm-blocked",
    },
    {
      name: "keeps heartbeat delivery to plugin-classified groups",
      entry: {
        sessionId: "sess-heartbeat-forum-group",
        updatedAt: 1,
        lastChannel: "forum",
        lastTo: "room:ops",
      },
      expectedChannel: "forum",
      expectedTo: "room:ops",
    },
    {
      name: "allows heartbeat delivery to unknown-shape targets when session chatType is direct",
      entry: {
        sessionId: "sess-heartbeat-beta-direct",
        updatedAt: 1,
        lastChannel: "beta",
        lastTo: "unknown-shape",
        chatType: "direct",
      },
      expectedChannel: "beta",
      expectedTo: "unknown-shape",
    },
    {
      name: "keeps heartbeat delivery to generic group targets",
      entry: {
        sessionId: "sess-heartbeat-alpha-group",
        updatedAt: 1,
        lastChannel: "alpha",
        lastTo: "group:ops",
      },
      expectedChannel: "alpha",
      expectedTo: "group:ops",
    },
    {
      name: "uses session chatType hints when target parsing cannot classify a direct chat",
      entry: {
        sessionId: "sess-heartbeat-alpha-unknown-direct",
        updatedAt: 1,
        lastChannel: "alpha",
        lastTo: "chat-guid-unknown-shape",
        chatType: "direct",
      },
      expectedChannel: "alpha",
      expectedTo: "chat-guid-unknown-shape",
    },
    {
      name: "blocks session chatType direct hints when directPolicy is block",
      entry: {
        sessionId: "sess-heartbeat-alpha-unknown-direct-blocked",
        updatedAt: 1,
        lastChannel: "alpha",
        lastTo: "chat-guid-unknown-shape",
        chatType: "direct",
      },
      directPolicy: "block" as const,
      expectedChannel: "none",
      expectedReason: "dm-blocked",
    },
  ] satisfies Array<{
    name: string;
    entry: LegacyDeliveryFixture;
    directPolicy?: "allow" | "block";
    expectedChannel: string;
    expectedTo?: string;
    expectedReason?: string;
  }>)(
    "$name",
    async ({ name, entry, directPolicy, expectedChannel, expectedTo, expectedReason }) => {
      await expectHeartbeatTarget({
        name,
        entry,
        directPolicy,
        expectedChannel,
        expectedTo,
        expectedReason,
      });
    },
  );

  it("keeps heartbeat delivery to core channel target prefixes", async () => {
    const cfg: OpenClawConfig = {};
    const resolved = await resolveHeartbeatDeliveryTarget({
      cfg,
      entry: {
        sessionId: "sess-heartbeat-core-channel-prefix",
        updatedAt: 1,
        lastChannel: "alpha",
        lastTo: "channel:999",
      },
      heartbeat: {
        target: "last",
      },
    });

    expect(resolved.channel).toBe("alpha");
    expect(resolved.to).toBe("channel:999");
  });

  it.each([
    {
      name: "raw target before route resolution",
      canonical: false,
      to: "room:ops:topic:1008013",
      threadId: undefined,
    },
    {
      name: "canonical target after route resolution",
      canonical: true,
      to: "room:ops",
      threadId: 1008013,
    },
  ])("preserves the heartbeat $name", async ({ canonical, to, threadId }) => {
    const cfg: OpenClawConfig = {};
    const heartbeat = { target: "forum", to: "room:ops:topic:1008013" };
    const resolved = canonical
      ? await resolveHeartbeatDeliveryTargetWithSessionRoute({ cfg, agentId: "main", heartbeat })
      : await resolveHeartbeatDeliveryTarget({ cfg, heartbeat });
    expect(resolved.channel).toBe("forum");
    expect(resolved.to).toBe(to);
    expect(resolved.threadId).toBe(threadId);
    if (canonical) {
      expect(mocks.resolveOutboundChannelPlugin).toHaveBeenCalledWith({
        channel: "forum",
        cfg,
        agentId: "main",
        allowBootstrap: true,
      });
    }
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

    const resolved = await resolveHeartbeatDeliveryTarget({
      cfg,
      agentId: "ops",
      heartbeat: { target: "owner" },
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
      name: "valid route",
      to: "room:ops",
      agentId: "ops",
      accountId: undefined,
      expected: { channel: "forum", to: "room:ops" },
    },
    {
      name: "invalid target",
      to: "invalid",
      agentId: undefined,
      accountId: undefined,
      expected: { channel: "none", reason: "no-target" },
    },
    {
      name: "invalid account",
      to: "room:ops",
      agentId: undefined,
      accountId: "missing-account",
      expected: { channel: "none", reason: "unknown-account" },
    },
  ])("validates a bootstrapped plugin's $name", async ({ to, agentId, accountId, expected }) => {
    const forum = createForumTargetTestPlugin();
    if (accountId) {
      forum.config = { ...forum.config, listAccountIds: () => ["valid-account"] };
    }
    setActivePluginRegistry(createTargetsTestRegistry([]));
    mocks.resolveOutboundChannelPlugin.mockImplementation(
      ({ channel, allowBootstrap }: { channel: string; allowBootstrap?: boolean }) =>
        channel === "forum" && allowBootstrap === true ? forum : undefined,
    );
    const resolved = await resolveHeartbeatDeliveryTarget({
      cfg: {},
      agentId,
      entry: session({ lastChannel: "forum", lastTo: to }),
      heartbeat: { target: "last", accountId },
    });
    expect(resolved).toMatchObject(expected);
    if (agentId) {
      expect(mocks.resolveOutboundChannelPlugin).toHaveBeenCalledWith({
        channel: "forum",
        cfg: {},
        agentId,
        allowBootstrap: true,
      });
    }
    expect(
      mocks.resolveOutboundChannelPlugin.mock.calls.filter(
        ([params]) => params.allowBootstrap === true,
      ),
    ).toHaveLength(1);
  });

  it("bootstraps explicit external heartbeat targets before strict validation", async () => {
    const external = {
      ...createForumTargetTestPlugin(),
      id: "external-channel",
    };
    mocks.resolveOutboundChannelPlugin.mockImplementation(
      ({ channel, allowBootstrap }: { channel: string; allowBootstrap?: boolean }) =>
        channel === "external-channel" && allowBootstrap === true ? external : undefined,
    );

    const resolved = await resolveHeartbeatDeliveryTarget({
      cfg: {},
      entry: {
        sessionId: "sess-external-account",
        updatedAt: 1,
        lastChannel: "external-channel",
        lastTo: "room:previous",
        lastAccountId: "account-2",
      },
      heartbeat: {
        target: "external-channel",
        to: "room:ops",
      },
    });

    expect(resolved.channel).toBe("external-channel");
    expect(resolved.to).toBe("room:ops");
    expect(resolved.accountId).toBe("account-2");
    expect(mocks.resolveOutboundChannelPlugin).toHaveBeenCalledWith({
      channel: "external-channel",
      cfg: {},
      allowBootstrap: true,
    });
  });

  it.each([
    { name: "explicit policy on a bootstrapped channel", bootstrap: true },
    { name: "configured default policy", bootstrap: false },
  ])("blocks canonical direct heartbeat routes using $name", async ({ bootstrap }) => {
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
    setActivePluginRegistry(createTargetsTestRegistry(bootstrap ? [] : [routedAlpha]));
    if (bootstrap) {
      mocks.resolveOutboundChannelPlugin.mockImplementation(
        ({ channel, allowBootstrap }: { channel: string; allowBootstrap?: boolean }) => {
          if (channel !== "alpha") {
            return undefined;
          }
          if (allowBootstrap === true) {
            setActivePluginRegistry(createTargetsTestRegistry([routedAlpha]));
            return routedAlpha;
          }
          return getActivePluginRegistry()?.channels.find((entry) => entry?.plugin?.id === channel)
            ?.plugin;
        },
      );
    }
    const heartbeat = { target: "last", directPolicy: "block" } as const;
    const resolved = await resolveHeartbeatDeliveryTargetWithSessionRoute({
      cfg: bootstrap ? {} : { agents: { defaults: { heartbeat } } },
      agentId: "main",
      entry: session({ lastChannel: "alpha", lastTo: "channel:D123" }),
      heartbeat: bootstrap ? heartbeat : undefined,
    });
    expect(resolved.channel).toBe("none");
    expect(resolved.reason).toBe("dm-blocked");
  });

  it("uses resolved target kind before applying heartbeat directPolicy to routed handles", async () => {
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

    const resolved = await resolveHeartbeatDeliveryTargetWithSessionRoute({
      cfg: {},
      agentId: "main",
      heartbeat: {
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

    const resolved = await resolveHeartbeatDeliveryTargetWithSessionRoute({
      cfg: { channels: { alpha: { allowFrom: ["operator"] } } } as OpenClawConfig,
      agentId: "main",
      heartbeat: { target: "owner" },
    });

    expect(resolved).toMatchObject({ channel: "none", reason: "no-route" });
  });

  it.each([
    {
      name: "Google Chat user",
      id: "googlechat",
      ownerId: "users/abc",
      classify: ({ to }) => (to.startsWith("users/") ? "direct" : undefined),
      expected: { channel: "googlechat", to: "users/abc" },
    },
    {
      name: "Google Chat space",
      id: "googlechat",
      ownerId: "spaces/xyz",
      classify: ({ to }) => (to.startsWith("spaces/") ? "group" : undefined),
    },
    { name: "group handle", id: "telegram", ownerId: "@shared", classify: () => "group" },
    {
      name: "user-prefixed group",
      id: "telegram",
      ownerId: "user:shared",
      classify: () => "group",
    },
    { name: "unclassified opaque id", id: "external-channel", ownerId: "opaque-owner-id" },
    {
      name: "unclassified user prefix",
      id: "external-channel",
      ownerId: "user:shared",
      emptyConfig: true,
    },
  ] satisfies Array<{
    name: string;
    id: ChannelPlugin["id"];
    ownerId: string;
    classify?: NonNullable<ChannelPlugin["messaging"]>["inferTargetChatType"];
    expected?: { channel: string; to: string };
    emptyConfig?: boolean;
  }>)(
    "requires a proven direct owner route for $name",
    async ({ id, ownerId, classify, expected, emptyConfig }) => {
      const plugin = createOwnerAllowlistTargetTestPlugin({
        id,
        label: id,
        ownerId,
        inferTargetChatType: classify,
      });
      setActivePluginRegistry(createTargetsTestRegistry([plugin]));
      const resolved = await resolveHeartbeatDeliveryTargetWithSessionRoute({
        cfg: emptyConfig ? {} : { channels: { [id]: { allowFrom: [ownerId] } } },
        agentId: "main",
        heartbeat: { target: "owner" },
      });
      expect(resolved).toMatchObject(expected ?? { channel: "none", reason: "no-route" });
    },
  );

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

    const resolved = await resolveHeartbeatDeliveryTarget({
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
      heartbeat: { target: "owner" },
    });

    // Precedence and channel binding are under test; the passthrough fixture
    // resolveTarget keeps the raw prefixed form (stripping is covered elsewhere).
    expect(resolved).toMatchObject({ channel: "telegram", to: "telegram:456" });
  });

  it.each([
    { target: undefined, source: false, purpose: "heartbeat-owner" },
    { target: "owner", source: false, purpose: "heartbeat-owner" },
    { target: "whatsapp", source: false, purpose: undefined },
    { target: "owner", source: true, purpose: undefined },
  ] as const)(
    "marks only owner-derived plugin routes: target=$target, source=$source",
    async ({ target, source, purpose }) => {
      const plugin = createOwnerAllowlistTargetTestPlugin({
        id: "whatsapp",
        label: "WhatsApp",
        ownerId: "+15555550166",
        inferTargetChatType: () => "direct",
      });
      const resolveRoute = vi.fn().mockResolvedValue(null);
      plugin.messaging = { ...plugin.messaging, resolveOutboundSessionRoute: resolveRoute };
      setActivePluginRegistry(createTargetsTestRegistry([plugin]));
      const resolved = await resolveHeartbeatDeliveryTargetWithSessionRoute({
        cfg: { channels: { whatsapp: { allowFrom: ["+15555550166"] } } },
        agentId: "main",
        heartbeat: { target, to: "+15555550166" },
        turnSource: source ? { channel: "whatsapp", to: "+15555550166" } : undefined,
      });
      expect(resolved).toMatchObject({ channel: "whatsapp", to: "+15555550166" });
      expect(resolveRoute).toHaveBeenCalledOnce();
      expect(resolveRoute.mock.calls[0]?.[0].deliveryPurpose).toBe(purpose);
    },
  );

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

    expect(await hasResolvableHeartbeatOwnerRoute({ cfg })).toBe(true);

    const resolved = await resolveHeartbeatDeliveryTargetWithSessionRoute({
      cfg,
      agentId: "main",
      heartbeat: { target: "owner" },
    });

    expect(resolved).toMatchObject({ channel: "whatsapp", to: "+15555550166" });
    expect(inferTargetChatType).toHaveBeenCalledWith({ to: "+15555550166" });
  });

  it("uses an activation-aware external plugin when canonicalizing heartbeat routes", async () => {
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
        resolveOutboundSessionRoute: ({ target, resolvedTarget }) => {
          const isDirect = resolvedTarget?.kind === "user";
          return {
            sessionKey: `main:external-channel:${isDirect ? "user" : "group"}:${target}`,
            baseSessionKey: `main:external-channel:${isDirect ? "user" : "group"}:${target}`,
            peer: { kind: isDirect ? "direct" : "group", id: target },
            chatType: isDirect ? "direct" : "group",
            from: `external-channel:${target}`,
            to: target,
          };
        },
      },
    });
    const setupExternal = { ...external, messaging: undefined };
    setActivePluginRegistry(createTargetsTestRegistry([setupExternal]));
    mocks.resolveOutboundChannelPlugin.mockImplementation(
      ({ channel, allowBootstrap }: { channel: string; allowBootstrap?: boolean }) => {
        if (channel !== "external-channel") {
          return undefined;
        }
        if (allowBootstrap === true) {
          return external;
        }
        return setupExternal;
      },
    );

    const resolved = await resolveHeartbeatDeliveryTargetWithSessionRoute({
      cfg: {},
      agentId: "main",
      heartbeat: {
        target: "external-channel",
        to: "person-123",
        directPolicy: "block",
      },
    });

    expect(resolved.channel).toBe("none");
    expect(resolved.reason).toBe("dm-blocked");
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

    const resolved = await resolveHeartbeatDeliveryTargetWithSessionRoute({
      cfg: {},
      agentId: "main",
      heartbeat: {
        target: "external-channel",
        to: "person-123",
        directPolicy: "block",
      },
    });

    expect(resolved.channel).toBe("none");
    expect(resolved.reason).toBe("dm-blocked");
  });

  it("uses an activation-aware infer-only plugin for heartbeat direct policy", async () => {
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

    const resolved = await resolveHeartbeatDeliveryTarget({
      cfg: {},
      heartbeat: {
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
  ])("resolves heartbeat reserved literals: $name", async ({ groups, expected }) => {
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
    const resolved = await resolveHeartbeatDeliveryTargetWithSessionRoute({
      cfg: {},
      agentId: "main",
      heartbeat: { target: "telegram", to: "current" },
    });
    expect(resolved).toMatchObject(expected);
    expect(listGroups).toHaveBeenCalled();
    if (!groups.length) {
      expect(listGroupsLive).toHaveBeenCalled();
    }
  });

  it("keeps heartbeat route canonicalization best-effort when target resolution fails", async () => {
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
              resolveTarget: async () => {
                throw new Error("directory unavailable");
              },
            },
            resolveOutboundSessionRoute: ({ target }) => ({
              sessionKey: `main:telegram:group:${target}`,
              baseSessionKey: `main:telegram:group:${target}`,
              peer: { kind: "group", id: target },
              chatType: "group",
              from: `telegram:group:${target}`,
              to: target,
            }),
          },
        }),
      ]),
    );

    const resolved = await resolveHeartbeatDeliveryTargetWithSessionRoute({
      cfg: {},
      agentId: "main",
      heartbeat: {
        target: "telegram",
        to: "@public_group",
      },
    });

    expect(resolved.channel).toBe("telegram");
    expect(resolved.to).toBe("@public_group");
    expect(resolved.chatType).toBe("group");
  });

  it("keeps heartbeat route canonicalization best-effort when route resolution fails", async () => {
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

    const resolved = await resolveHeartbeatDeliveryTargetWithSessionRoute({
      cfg: {},
      agentId: "main",
      entry: {
        sessionId: "sess-heartbeat-route-failure",
        updatedAt: 1,
        lastChannel: "alpha",
        lastTo: "group:ops",
      },
      heartbeat: {
        target: "last",
      },
    });

    expect(resolved.channel).toBe("alpha");
    expect(resolved.to).toBe("group:ops");
    expect(resolved.chatType).toBe("group");
  });

  it.each([
    {
      name: "group route",
      entry: session({
        lastChannel: "forum",
        lastTo: "room:ops",
        lastThreadId: 1122,
        chatType: "group",
      }),
      to: "room:ops",
      threadId: 1122,
    },
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
  ])("inherits heartbeat threads only for $name", async ({ entry, to, threadId }) => {
    const resolved = await resolveHeartbeatDeliveryTarget({
      cfg: {},
      entry,
      heartbeat: { target: "last" },
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
    {
      name: "same group conversation remains deliverable",
      storedTo: "group:ops",
      storedType: "group",
      eventTo: "group:ops",
      expectedChannel: "alpha",
      expectedType: "group",
    },
  ] as const)(
    "qualifies heartbeat chat type by the selected conversation: $name",
    async ({ storedTo, storedType, eventTo, expectedChannel, expectedType }) => {
      const resolved = await resolveHeartbeatDeliveryTargetWithSessionRoute({
        cfg: {},
        agentId: "main",
        entry: {
          sessionId: "chat-type-owner",
          updatedAt: 1,
          lastChannel: "alpha",
          lastTo: storedTo,
          chatType: storedType,
        },
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

  it.each([
    {
      name: "complete turn source",
      storedChannel: "alpha",
      storedTo: "wrong-room",
      turnSource: { channel: "forum", to: "room:ops", threadId: 42 },
    },
    {
      name: "partial turn source",
      storedChannel: "forum",
      storedTo: "room:ops",
      turnSource: { threadId: 42 },
    },
  ])("merges heartbeat routing from $name", async ({ storedChannel, storedTo, turnSource }) => {
    const resolved = await resolveHeartbeatDeliveryTarget({
      cfg: {},
      entry: session({ lastChannel: storedChannel, lastTo: storedTo }),
      heartbeat: { target: "last" },
      turnSource,
    });
    expect(resolved.channel).toBe("forum");
    expect(resolved.to).toBe("room:ops");
    expect(resolved.threadId).toBe(42);
  });
});

describe("resolveSessionDeliveryTarget — cross-channel reply guard (#24152)", () => {
  const topicSession = session({ lastChannel: "forum", lastTo: "room:ops", lastThreadId: 1122 });
  const changedSession = session({ lastChannel: "beta", lastTo: "wrong-room" });
  it.each([
    {
      name: "turn source overrides a concurrently updated session",
      input: { entry: changedSession, turnSourceChannel: "alpha", turnSourceTo: "room-one" },
      expected: { channel: "alpha", to: "room-one" },
    },
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
        entry: { ...changedSession, lastAccountId: "wrong-account" },
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
      input: { entry: topicSession, turnSourceChannel: "forum", turnSourceTo: "room:ops" },
      expected: { channel: "forum", to: "room:ops", threadId: 1122 },
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
      name: "matching plugin-owned topic identity retains thread",
      input: {
        entry: { ...topicSession, lastTo: "forum:room:ops:topic:1122" },
        turnSourceChannel: "forum",
        turnSourceTo: "forum:room:ops:topic:1122",
      },
      expected: { channel: "forum", to: "forum:room:ops:topic:1122", threadId: 1122 },
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
      name: "different channel cannot inherit session thread",
      input: {
        entry: session({ lastChannel: "alpha", lastTo: "room-one", lastThreadId: "thread-1" }),
        turnSourceChannel: "forum",
        turnSourceTo: "room:ops",
      },
      expected: { channel: "forum", threadId: undefined },
    },
    {
      name: "explicit turn thread overrides session thread",
      input: {
        entry: topicSession,
        turnSourceChannel: "forum",
        turnSourceTo: "room:ops",
        turnSourceThreadId: 9999,
      },
      expected: { channel: "forum", to: "room:ops", threadId: 9999 },
    },
    {
      name: "different destination cannot inherit session thread",
      input: { entry: topicSession, turnSourceChannel: "forum", turnSourceTo: "room:other" },
      expected: { channel: "forum", to: "room:other", threadId: undefined },
    },
    {
      name: "explicit target works without turn target",
      input: { entry: changedSession, explicitTo: "room-one", turnSourceChannel: "alpha" },
      expected: { channel: "alpha", to: "room-one" },
    },
    {
      name: "mismatched channel uses only the turn target",
      input: {
        entry: session({ lastChannel: "alpha", lastTo: "wrong-room" }),
        requestedChannel: "beta",
        allowMismatchedLastTo: true,
        turnSourceChannel: "alpha",
        turnSourceTo: "room-one",
      },
      expected: { channel: "beta", to: "room-one" },
    },
  ] satisfies SessionTargetCase[])("$name", ({ input, expected }) => {
    expect(resolveSessionDeliveryTarget({ requestedChannel: "last", ...input })).toMatchObject(
      expected,
    );
  });

  it.each([
    { name: "matching accounts", sessionAccountId: "work", turnSourceAccountId: "work" },
    { name: "unspecified turn account", sessionAccountId: "work", turnSourceAccountId: undefined },
    {
      name: "unspecified session account",
      sessionAccountId: undefined,
      turnSourceAccountId: "work",
    },
  ])("inherits the session topic with $name", ({ sessionAccountId, turnSourceAccountId }) => {
    const resolved = resolveSessionDeliveryTarget({
      entry: { ...topicSession, lastAccountId: sessionAccountId },
      requestedChannel: "last",
      turnSourceChannel: "forum",
      turnSourceTo: "room:ops",
      turnSourceAccountId,
    });
    expect(resolved.accountId).toBe(turnSourceAccountId);
    expect(resolved.threadId).toBe(1122);
    expect(resolved.threadIdSource).toBe("session");
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
