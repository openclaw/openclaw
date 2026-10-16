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

// Discord API v10 GuildPublicThread channel type.
const guildPublicThreadType = 11;
const guildId = "100000000000000001";
const current = "100000000000000002";
const sibling = "100000000000000003";
const userId = "100000000000000004";
const botId = "100000000000000005";
const dmId = "100000000000000007";
const messageId = "100000000000000010";
const allowedThreadId = "100000000000000020";
const siblingThreadId = "100000000000000021";
const unknownThreadId = "100000000000000022";
const deniedThreadId = "100000000000000023";
const missingGuildThreadId = "100000000000000024";
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
const getRequest = (path: string) => ({ method: "GET", path });
const activeThreadsPath = `/guilds/${guildId}/threads/active`;
const thread = (id: string, parent_id: string, name: string) => ({
  id,
  type: guildPublicThreadType,
  guild_id: guildId,
  parent_id,
  name,
});
const allowedThread = thread(allowedThreadId, current, "Allowed thread");

function metadataRead(
  action: ChannelMessageActionContext["action"],
  gate: keyof DiscordActionConfig,
  path: string,
  result: unknown,
  params: Record<string, unknown> = { guildId },
) {
  return { action, gate, path, result, params };
}

const metadataReads = [
  metadataRead(
    "permissions",
    "permissions",
    "/users/%40me",
    {
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
    { channelId: sibling },
  ),
  metadataRead(
    "member-info",
    "memberInfo",
    `/guilds/${guildId}/members/${userId}`,
    { ok: true, member },
    { guildId, userId },
  ),
  metadataRead("role-info", "roleInfo", `/guilds/${guildId}/roles`, { ok: true, roles: [role] }),
  metadataRead("emoji-list", "reactions", `/guilds/${guildId}/emojis`, {
    ok: true,
    emojis: [
      { name: "alpha", identifier: "alpha:1", animated: true },
      { name: "beta", identifier: "beta:2" },
    ],
  }),
  metadataRead("channel-list", "channelInfo", `/guilds/${guildId}/channels`, {
    ok: true,
    channels,
  }),
  metadataRead(
    "voice-status",
    "voiceStatus",
    `/guilds/${guildId}/voice-states/${userId}`,
    { ok: true, voice },
    { guildId, userId },
  ),
  metadataRead("event-list", "events", `/guilds/${guildId}/scheduled-events`, { ok: true, events }),
];

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
    [
      activeThreadsPath,
      {
        body: {
          threads: [
            allowedThread,
            thread(siblingThreadId, sibling, "Sibling thread"),
            { id: unknownThreadId, name: "Unknown parent" },
            thread(deniedThreadId, current, "Disabled child thread"),
            {
              id: missingGuildThreadId,
              type: guildPublicThreadType,
              parent_id: current,
              name: "Missing guild metadata",
            },
          ],
          members: [
            { id: allowedThreadId },
            { id: siblingThreadId },
            { id: unknownThreadId },
            { id: deniedThreadId },
            { id: missingGuildThreadId },
          ],
          extra: "guild metadata must not escape",
        },
      },
    ],
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
  const dispatch = (
    action: ChannelMessageActionContext["action"],
    params: ChannelMessageActionContext["params"] = { guildId },
    overrides: Partial<ChannelMessageActionContext> = {},
  ) => dispatchChannelMessageAction({ ...fixture.context, action, params, ...overrides });
  const dispatchDm = (target: string, overrides: Partial<ChannelMessageActionContext> = {}) =>
    dispatchChannelMessageAction({
      ...fixture.dmContext,
      params: { ...fixture.dmContext.params, target, to: target },
      ...overrides,
    });
  const allowCurrentThreads = () => {
    fixture.discord.guilds = {
      [guildId]: {
        channels: { [current]: { enabled: true }, [deniedThreadId]: { enabled: false } },
      },
    };
  };
  const expectNoActiveInventory = () => {
    expect(fixture.requests).not.toContainEqual(getRequest(activeThreadsPath));
  };
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

  it.each([current, `channel:${current}`, `discord:channel:${current}`])(
    "reads active threads under an allowlisted parent through the registered plugin (%s)",
    async (channelId) => {
      allowCurrentThreads();
      const result = await dispatch("thread-list", { guildId, channelId });
      expect(result?.details).toMatchObject({ ok: true, returnedCount: 1 });
      expect((result?.details as { threads?: unknown })?.threads).toEqual({
        threads: [allowedThread],
        members: [{ id: allowedThreadId }],
      });
      expect(fixture.requests).toContainEqual(getRequest(activeThreadsPath));
      expect(fixture.requests).not.toContainEqual(getRequest(`/channels/${allowedThreadId}`));
      expect(fixture.requests).not.toContainEqual(getRequest(`/channels/${deniedThreadId}`));
      expect(fixture.requests.every((request) => request.method === "GET")).toBe(true);
    },
  );

  it("rejects active inventory under a non-allowlisted parent before fetching it", async () => {
    allowCurrentThreads();
    await expect(dispatch("thread-list", { guildId, channelId: sibling })).rejects.toThrow(
      "Discord read target channel is not allowed.",
    );
    expectNoActiveInventory();
  });

  it.each(["malformed", "unavailable", "mismatched"])(
    "rejects %s active-thread metadata",
    async (metadata) => {
      allowCurrentThreads();
      if (metadata === "unavailable") {
        fixture.routes.delete(`/channels/${current}`);
      } else {
        fixture.routes.set(metadata === "malformed" ? activeThreadsPath : `/channels/${current}`, {
          body:
            metadata === "malformed"
              ? { threads: [{ id: allowedThreadId, parent_id: current }] }
              : { ...channels[0], guild_id: sibling },
        });
      }

      await expect(dispatch("thread-list", { guildId, channelId: current })).rejects.toThrow(
        metadata === "malformed"
          ? "Unexpected Discord response for active thread list."
          : "Discord active thread parent metadata is unavailable.",
      );
      if (metadata !== "malformed") {
        expectNoActiveInventory();
      }
    },
  );

  it.each([dmId, `channel:${dmId}`, `user:${userId}`])(
    "reacts in the current DM through its registered adapter (%s)",
    async (target) => {
      const result = await dispatchDm(target);

      expect(result?.details).toEqual({ ok: true, added: "✅" });
      expect(fixture.requests.filter(({ method }) => method === "PUT")).toEqual([
        { method: "PUT", path: `/channels/${dmId}/messages/${messageId}/reactions/%E2%9C%85/@me` },
      ]);
    },
  );

  it.each([
    `channel:100000000000000008`,
    `user:100000000000000009`,
    `channel:${userId}`,
    `user:${dmId}`,
  ])("rejects another channel, user or namespace before I/O (%s)", async (target) => {
    await expect(dispatchDm(target)).rejects.toThrow("exact current conversation");
    expect(fixture.requests).toEqual([]);
  });

  it.each(["account", "provider"])("retains current DM %s restrictions", async (mismatch) => {
    await expect(
      dispatchDm(
        `channel:${dmId}`,
        mismatch === "account"
          ? { requesterAccountId: "other" }
          : { toolContext: { ...fixture.dmContext.toolContext, currentChannelProvider: "slack" } },
      ),
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
        (await prepareExternalMessageActionTargetForResolution(context)).assertReadAuthorityCurrent,
      ).toBeTypeOf("function");
      expect(fixture.requests).toContainEqual({ method: "GET", path: read.path });
      expect(fixture.requests.every((request) => request.method === "GET")).toBe(true);
    },
  );

  it.each(metadataReads)("retains the $action action gate", async (read) => {
    fixture.discord.actions = { [read.gate]: false };
    await expect(dispatch(read.action, read.params)).rejects.toThrow("disabled");
    expect(fixture.requests).toEqual([]);
  });

  it.each(
    metadataReads.filter(({ action }) =>
      ["role-info", "emoji-list", "channel-list"].includes(action),
    ),
  )("retains guild and wildcard channel restrictions for $action", async (read) => {
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
  });

  it("checks the permissions destination before reading bot permissions", async () => {
    fixture.discord.guilds = { [guildId]: { channels: { [current]: { enabled: true } } } };
    await expect(dispatch("permissions", { channelId: sibling })).rejects.toThrow("not allowed");
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
        await dispatch("channel-list", context.params, {
          conversationReadOrigin: "direct-operator",
        })
      )?.details,
    ).toEqual({ ok: true, channels: [channels[0]] });
  });

  it("rejects a forged operator origin without a current conversation", async () => {
    await expect(
      dispatch(
        "role-info",
        { guildId, conversationReadOrigin: "direct-operator" },
        { toolContext: { currentChannelProvider: "discord" } },
      ),
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
    expect((await dispatch("voice-status", { guildId, userId }))?.details).toEqual({
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
    expect((await dispatch("emoji-list", { limit: 1 }))?.details).toEqual({
      ok: true,
      emojis: [{ name: "alpha", identifier: "alpha:1", animated: true }],
    });
    expect(fixture.requests).toEqual([
      { method: "GET", path: `/channels/${current}` },
      { method: "GET", path: `/guilds/${guildId}/emojis` },
    ]);
  });

  it("retains captured authority between permissions lookup requests", async () => {
    fixture.transport.onRequest = () => {
      fixture.record.enabled = false;
    };
    await expect(dispatch("permissions", { channelId: sibling })).rejects.toThrow(
      "no longer active",
    );
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
