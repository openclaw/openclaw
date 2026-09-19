import { createServer } from "node:http";
import { Value } from "typebox/value";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { discordPlugin } from "../extensions/discord/api.js";
import { createMessageTool } from "../src/agents/tools/message-tool-execution.js";
import {
  dispatchChannelMessageAction,
  prepareExternalMessageActionTargetForResolution,
  shouldDeferExternalMessageActionTargetResolution,
} from "../src/channels/plugins/message-action-dispatch.js";
import type { ChannelMessageActionContext } from "../src/channels/plugins/types.js";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../src/config/config.js";
import type { DiscordActionConfig, DiscordConfig, OpenClawConfig } from "../src/config/types.js";
import { runMessageAction } from "../src/infra/outbound/message-action-runner.js";
import { resolveAndApplyOutboundReplyToId } from "../src/infra/outbound/message-action-threading.js";
import { isDeliveredCurrentSourceReply } from "../src/infra/outbound/source-reply-mirror.js";
import { createPluginRegistry } from "../src/plugins/registry.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../src/plugins/runtime.js";
import type { PluginRuntime } from "../src/plugins/runtime/types.js";
import { createPluginRecord } from "../src/plugins/status.test-fixtures.js";

const guildId = "100000000000000001";
const current = "100000000000000002";
const sibling = "100000000000000003";
const userId = "100000000000000004";
const botId = "100000000000000005";
const dmId = "100000000000000007";
const messageId = "100000000000000010";
const role = { id: guildId, name: "@everyone", permissions: "1024" };
const member = { user: { id: userId, username: "member" }, roles: [guildId] };
const channels = [current, sibling].map((id) => ({
  id,
  type: 0,
  guild_id: guildId,
  name: id === current ? "current" : "sibling",
  permission_overwrites: [],
}));
const voice = { guild_id: guildId, user_id: userId, channel_id: sibling, session_id: "fixture" };
const events = [{ id: "100000000000000006", guild_id: guildId, name: "Planning" }];

const metadataReads = [
  {
    action: "permissions",
    gate: "permissions",
    params: { channelId: sibling },
    path: "/users/%40me",
    result: {
      ok: true,
      permissions: {
        channelId: sibling,
        guildId,
        permissions: ["ViewChannel"],
        raw: "1024",
        isDm: false,
        channelType: 0,
      },
    },
  },
  {
    action: "member-info",
    gate: "memberInfo",
    params: { guildId, userId },
    path: `/guilds/${guildId}/members/${userId}`,
    result: { ok: true, member },
  },
  {
    action: "role-info",
    gate: "roleInfo",
    params: { guildId },
    path: `/guilds/${guildId}/roles`,
    result: { ok: true, roles: [role] },
  },
  {
    action: "emoji-list",
    gate: "reactions",
    params: { guildId },
    path: `/guilds/${guildId}/emojis`,
    result: {
      ok: true,
      emojis: [
        { name: "alpha", identifier: "alpha:1", animated: true },
        { name: "beta", identifier: "beta:2" },
      ],
    },
  },
  {
    action: "channel-list",
    gate: "channelInfo",
    params: { guildId },
    path: `/guilds/${guildId}/channels`,
    result: { ok: true, channels },
  },
  {
    action: "voice-status",
    gate: "voiceStatus",
    params: { guildId, userId },
    path: `/guilds/${guildId}/voice-states/${userId}`,
    result: { ok: true, voice },
  },
  {
    action: "event-list",
    gate: "events",
    params: { guildId },
    path: `/guilds/${guildId}/scheduled-events`,
    result: { ok: true, events },
  },
] satisfies Array<{
  action: ChannelMessageActionContext["action"];
  gate: keyof DiscordActionConfig;
  params: Record<string, unknown>;
  path: string;
  result: unknown;
}>;

async function createFixture() {
  const discord: DiscordConfig = {
    enabled: true,
    token: "synthetic-provider-fixture",
    groupPolicy: "allowlist",
    guilds: { [guildId]: { channels: { "*": { enabled: true } } } },
  };
  const cfg: OpenClawConfig = { channels: { discord } };
  const owner = createPluginRegistry({
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    runtime: {} as PluginRuntime,
    activateGlobalSideEffects: false,
  });
  // Installer provenance is covered separately; this exercises the real registrar and adapter.
  const record = createPluginRecord({
    id: "discord",
    origin: "global",
    trustedOfficialInstall: true,
  });
  const plugin = {
    ...discordPlugin,
    status: undefined,
    actions: {
      ...discordPlugin.actions!,
      readAuthorityActions: discordPlugin.actions?.readAuthorityActions,
    },
  };
  owner.registry.plugins.push(record);
  owner.createApi(record, { config: cfg, registrationMode: "full" }).registerChannel({ plugin });
  setActivePluginRegistry(owner.registry);
  setRuntimeConfigSnapshot(cfg, cfg);

  const routes = new Map<string, { body: unknown; status?: number }>([
    ...channels.map((channel) => [`/channels/${channel.id}`, { body: channel }] as const),
    ["/users/%40me", { body: { id: botId } }],
    [`/guilds/${guildId}`, { body: { id: guildId, name: "Fixture", roles: [role] } }],
    [`/guilds/${guildId}/members/${botId}`, { body: { user: { id: botId }, roles: [] } }],
    [`/guilds/${guildId}/members/${userId}`, { body: member }],
    [`/guilds/${guildId}/roles`, { body: [role] }],
    [
      `/guilds/${guildId}/emojis`,
      {
        body: [
          { id: "2", name: "beta", roles: [guildId] },
          { id: "1", name: "alpha", animated: true },
          { id: null, name: "unusable" },
        ],
      },
    ],
    [`/guilds/${guildId}/channels`, { body: channels }],
    [`/guilds/${guildId}/voice-states/${userId}`, { body: voice }],
    [`/guilds/${guildId}/scheduled-events`, { body: events }],
    [`/channels/${sibling}/messages`, { body: [] }],
    [`/channels/${dmId}`, { body: { id: dmId, type: 1 } }],
    ["/users/@me/channels", { body: { id: dmId } }],
    [`/channels/${dmId}/messages/${messageId}/reactions/%E2%9C%85/@me`, { body: {}, status: 204 }],
    [`/channels/${dmId}/messages`, { body: { id: "100000000000000011", channel_id: dmId } }],
  ]);
  const requests: Array<{ method: string; path: string }> = [];
  const transport = { onRequest: undefined as (() => void) | undefined };
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://localhost").pathname.replace(
      /^\/api\/v10/,
      "",
    );
    requests.push({ method: request.method ?? "", path });
    request.resume();
    transport.onRequest?.();
    const route = routes.get(path);
    response.writeHead(route?.status ?? (route ? 200 : 404), {
      "content-type": "application/json",
    });
    response.end(JSON.stringify(route?.body ?? { message: `Unexpected fixture route: ${path}` }));
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected loopback TCP address");
  }
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const realFetch = globalThis.fetch.bind(globalThis);
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin !== "https://discord.com" || !url.pathname.startsWith("/api/v10/")) {
      throw new Error("Unexpected provider request");
    }
    return realFetch(new URL(`${url.pathname}${url.search}`, baseUrl), init);
  });
  const context: ChannelMessageActionContext = {
    cfg,
    channel: "discord",
    action: "role-info",
    params: { guildId },
    accountId: "default",
    requesterAccountId: "default",
    conversationReadOrigin: "delegated",
    toolContext: { currentChannelProvider: "discord", currentChannelId: current },
  };
  const dmContext: ChannelMessageActionContext = {
    ...context,
    action: "react",
    requesterSenderId: userId,
    senderIsOwner: false,
    params: { messageId, emoji: "✅" },
    toolContext: {
      ...discordPlugin.threading?.buildToolContext?.({
        cfg,
        accountId: "default",
        context: {
          From: `discord:${userId}`,
          To: `user:${userId}`,
          NativeChannelId: dmId,
          ChatType: "direct",
          CurrentMessageId: messageId,
        },
      }),
      currentChannelProvider: "discord",
      replyToMode: "all",
    },
  };
  return {
    discord,
    cfg,
    record,
    plugin,
    context,
    dmContext,
    routes,
    requests,
    transport,
    runPermissions: (target: string) =>
      runMessageAction({
        cfg,
        action: "permissions",
        params: { channel: "discord", target },
        defaultAccountId: "default",
        requesterAccountId: "default",
        conversationReadOrigin: "delegated",
        toolContext: context.toolContext,
      }),
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

describe("registered Discord metadata reads", () => {
  let fixture: Awaited<ReturnType<typeof createFixture>>;
  beforeEach(async () => {
    fixture = await createFixture();
  });
  afterEach(async () => {
    await fixture?.close();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    resetPluginRuntimeStateForTest();
    clearRuntimeConfigSnapshot();
  });

  it.each([dmId, `channel:${dmId}`, `user:${userId}`])(
    "reacts in the current DM through its registered adapter (%s)",
    async (target) => {
      const result = await dispatchChannelMessageAction({
        ...fixture.dmContext,
        params: { ...fixture.dmContext.params, target, to: target },
      });

      expect(result?.details).toEqual({ ok: true, added: "✅" });
      expect(fixture.requests.filter(({ method }) => method === "PUT")).toEqual([
        { method: "PUT", path: `/channels/${dmId}/messages/${messageId}/reactions/%E2%9C%85/@me` },
      ]);
    },
  );

  it.each([
    `channel:100000000000000008`,
    `user:100000000000000009`,
    `channel:${current}`,
    `channel:100000000000000012`,
    `channel:${userId}`,
    `user:${dmId}`,
  ])("rejects another DM, guild, thread, user or namespace before I/O (%s)", async (target) => {
    await expect(
      dispatchChannelMessageAction({
        ...fixture.dmContext,
        params: { ...fixture.dmContext.params, target, to: target },
      }),
    ).rejects.toThrow("exact current conversation");
    expect(fixture.requests).toEqual([]);
  });

  it.each(["account", "provider"])("retains current DM %s restrictions", async (mismatch) => {
    await expect(
      dispatchChannelMessageAction({
        ...fixture.dmContext,
        params: { ...fixture.dmContext.params, target: `channel:${dmId}`, to: `channel:${dmId}` },
        ...(mismatch === "account"
          ? { requesterAccountId: "other" }
          : {
              toolContext: {
                ...fixture.dmContext.toolContext,
                currentChannelProvider: "slack",
              },
            }),
      }),
    ).rejects.toThrow("exact current conversation");
    expect(fixture.requests).toEqual([]);
  });

  it.each([dmId, `channel:${dmId}`, `user:${userId}`])(
    "preserves implicit replies and delivery tracking for the current DM (%s)",
    async (target) => {
      const params = { target, to: target, message: "Reply in the current DM" };
      const reply = resolveAndApplyOutboundReplyToId(params, {
        channel: "discord",
        toolContext: fixture.dmContext.toolContext,
        matchesToolContextTarget: fixture.plugin.threading?.matchesToolContextTarget,
      });
      expect(reply).toMatchObject({ replyToId: messageId, source: "implicit" });
      const result = await dispatchChannelMessageAction({
        ...fixture.dmContext,
        action: "send",
        params,
        reply,
      });

      expect(result?.details).toMatchObject({ ok: true, result: { channelId: dmId } });
      expect(fixture.requests.filter(({ path }) => path === `/channels/${dmId}/messages`)).toEqual([
        { method: "POST", path: `/channels/${dmId}/messages` },
      ]);
      expect(
        isDeliveredCurrentSourceReply({
          action: "send",
          channel: "discord",
          cfg: fixture.cfg,
          actionParams: params,
          deliveredPayload: result?.details,
          accountId: "default",
          currentAccountId: "default",
          sessionKey: `agent:main:discord:direct:${userId}`,
          toolContext: fixture.dmContext.toolContext,
        }),
      ).toBe(true);
    },
  );

  it.each(metadataReads)(
    "advertises and executes $action through the registered provider",
    async (read) => {
      const tool = createMessageTool({
        config: fixture.cfg,
        agentAccountId: "default",
        currentChannelProvider: "discord",
        currentChannelId: current,
      });
      const input = { action: read.action, channel: "discord", ...read.params };
      expect(Value.Check(tool.parameters, input)).toBe(true);
      const context = { ...fixture.context, action: read.action, params: { ...read.params } };
      expect(shouldDeferExternalMessageActionTargetResolution(context)).toBe(true);
      expect((await dispatchChannelMessageAction(context))?.details).toEqual(read.result);
      expect(
        prepareExternalMessageActionTargetForResolution(context).assertReadAuthorityCurrent,
      ).toBeTypeOf("function");
      expect(fixture.requests).toContainEqual({ method: "GET", path: read.path });
      expect(fixture.requests.every((request) => request.method === "GET")).toBe(true);
    },
  );

  it.each(metadataReads)("retains the $action action gate", async (read) => {
    fixture.discord.actions = { [read.gate]: false };
    await expect(
      dispatchChannelMessageAction({
        ...fixture.context,
        action: read.action,
        params: read.params,
      }),
    ).rejects.toThrow("disabled");
    expect(fixture.requests).toEqual([]);
  });

  it.each(metadataReads.filter((read) => read.action !== "permissions"))(
    "retains guild and wildcard channel restrictions for $action",
    async (read) => {
      const context = { ...fixture.context, action: read.action, params: read.params };
      fixture.discord.guilds = {};
      await expect(dispatchChannelMessageAction(context)).rejects.toThrow("not allowed");
      expect(fixture.requests).toEqual([{ method: "GET", path: `/guilds/${guildId}` }]);
      fixture.discord.guilds = { [guildId]: { channels: { [current]: { enabled: true } } } };
      await expect(dispatchChannelMessageAction(context)).rejects.toThrow(
        "wildcard channel allowlist",
      );
      fixture.discord.guilds = {
        [guildId]: { channels: { "*": { enabled: true }, [sibling]: { enabled: false } } },
      };
      await expect(dispatchChannelMessageAction(context)).rejects.toThrow(
        "wildcard channel allowlist",
      );
      expect(fixture.requests).toEqual([{ method: "GET", path: `/guilds/${guildId}` }]);
    },
  );

  it("checks the permissions destination before reading bot permissions", async () => {
    fixture.discord.guilds = { [guildId]: { channels: { [current]: { enabled: true } } } };
    await expect(
      dispatchChannelMessageAction({
        ...fixture.context,
        action: "permissions",
        params: { channelId: sibling },
      }),
    ).rejects.toThrow("not allowed");
    expect(fixture.requests).toEqual([{ method: "GET", path: `/channels/${sibling}` }]);
  });

  it("resolves a permissions channel through the shared message runner using only reads", async () => {
    expect(await fixture.runPermissions(`channel:${sibling}`)).toMatchObject({
      kind: "action",
      payload: { ok: true, permissions: { channelId: sibling } },
    });
    expect(fixture.requests).toContainEqual({ method: "GET", path: "/users/%40me" });
    expect(fixture.requests.every((request) => request.method === "GET")).toBe(true);
  });

  it.each([
    userId,
    `user:${userId}`,
    `discord:${userId}`,
    `discord:user:${userId}`,
    `<@${userId}>`,
    `<@!${userId}>`,
    `@${userId}`,
  ])("rejects a permissions user target without creating a DM (%s)", async (target) => {
    fixture.discord.allowFrom = [userId];
    await expect(fixture.runPermissions(target)).rejects.toThrow(
      /channel id is required|resolved to a user target/i,
    );
    expect(fixture.requests).toEqual([]);
  });

  it("keeps filtered channel-list relaxation exclusive to direct operators", async () => {
    fixture.discord.guilds = { [guildId]: { channels: { [sibling]: { enabled: false } } } };
    const context = { ...fixture.context, action: "channel-list" as const };
    await expect(dispatchChannelMessageAction(context)).rejects.toThrow(
      "wildcard channel allowlist",
    );
    expect(fixture.requests).toEqual([]);
    expect(
      (
        await dispatchChannelMessageAction({
          ...context,
          conversationReadOrigin: "direct-operator",
        })
      )?.details,
    ).toEqual({ ok: true, channels: [channels[0]] });
  });

  it.each([
    { requesterAccountId: "other" },
    { requesterAccountId: undefined },
    { toolContext: undefined },
    { toolContext: { currentChannelProvider: "slack", currentChannelId: current } },
    { toolContext: { currentChannelProvider: "discord" } },
  ])("retains server-owned account and origin context (%j)", async (mismatch) => {
    await expect(
      dispatchChannelMessageAction({
        ...fixture.context,
        ...mismatch,
        params: { guildId, conversationReadOrigin: "direct-operator" },
      }),
    ).rejects.toThrow("current provider and account context");
    expect(fixture.requests).toEqual([]);
  });

  it.each(["unverified", "legacy"] as const)(
    "keeps a %s registration exact-current-only",
    async (mode) => {
      if (mode === "unverified") {
        fixture.record.trustedOfficialInstall = false;
      } else {
        fixture.plugin.actions.readAuthorityActions = undefined;
      }
      await expect(dispatchChannelMessageAction(fixture.context)).rejects.toThrow(
        "exact current conversation",
      );
      expect(fixture.requests).toEqual([]);
    },
  );

  it("retains the original six-action read path and excludes mutations", async () => {
    const context = { ...fixture.context, params: { channelId: sibling } };
    expect(
      (await dispatchChannelMessageAction({ ...context, action: "read" }))?.details,
    ).toMatchObject({ ok: true, messages: [] });
    const reads = [...fixture.requests];
    for (const action of ["react", "edit", "delete", "pin", "unpin"] as const) {
      await expect(dispatchChannelMessageAction({ ...context, action })).rejects.toThrow(
        "exact current conversation",
      );
    }
    expect(fixture.requests).toEqual(reads);
  });

  it("requires a token for an uncached metadata request", async () => {
    fixture.discord.token = "";
    vi.stubEnv("DISCORD_BOT_TOKEN", undefined);
    await expect(dispatchChannelMessageAction(fixture.context)).rejects.toThrow(/token/i);
    expect(fixture.requests).toEqual([]);
  });

  it("returns unknown voice state as a normal absent result", async () => {
    fixture.routes.set(`/guilds/${guildId}/voice-states/${userId}`, {
      status: 404,
      body: { code: 10065, message: "Unknown Voice State" },
    });
    expect(
      (
        await dispatchChannelMessageAction({
          ...fixture.context,
          action: "voice-status",
          params: { guildId, userId },
        })
      )?.details,
    ).toEqual({
      ok: true,
      voice: {
        guild_id: guildId,
        user_id: userId,
        channel_id: null,
        connected: false,
        absent: true,
        reason: "unknown_voice_state",
      },
    });
  });

  it("resolves emoji-list from the current server channel", async () => {
    expect(
      (
        await dispatchChannelMessageAction({
          ...fixture.context,
          action: "emoji-list",
          params: { limit: 1 },
        })
      )?.details,
    ).toEqual({ ok: true, emojis: [{ name: "alpha", identifier: "alpha:1", animated: true }] });
    expect(fixture.requests).toEqual([
      { method: "GET", path: `/channels/${current}` },
      { method: "GET", path: `/guilds/${guildId}/emojis` },
    ]);
  });

  it("retains captured authority between permissions lookup requests", async () => {
    fixture.transport.onRequest = () => {
      fixture.record.enabled = false;
    };
    await expect(
      dispatchChannelMessageAction({
        ...fixture.context,
        action: "permissions",
        params: { channelId: sibling },
      }),
    ).rejects.toThrow("no longer active");
    expect(fixture.requests).toEqual([{ method: "GET", path: `/channels/${sibling}` }]);
  });

  it.each([200, 403, 429])(
    "rejects stale metadata results, errors and retries (HTTP %s)",
    async (status) => {
      fixture.routes.set(`/guilds/${guildId}/roles`, {
        status,
        body: status === 200 ? [role] : { message: "Fixture error", retry_after: 0 },
      });
      fixture.transport.onRequest = () => {
        fixture.record.enabled = false;
      };
      await expect(dispatchChannelMessageAction(fixture.context)).rejects.toThrow(
        "no longer active",
      );
      expect(fixture.requests).toEqual([{ method: "GET", path: `/guilds/${guildId}/roles` }]);
    },
  );
});
