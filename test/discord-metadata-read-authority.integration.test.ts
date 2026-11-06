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
import type { ChannelMessageActionContext } from "../src/channels/plugins/types.core.js";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../src/config/config.js";
import type { DiscordActionConfig, DiscordConfig, OpenClawConfig } from "../src/config/types.js";
import { runMessageAction } from "../src/infra/outbound/message-action-runner.js";
import { resolveAndApplyOutboundReplyToId } from "../src/infra/outbound/message-action-threading.js";
import { isDeliveredCurrentSourceReply } from "../src/infra/outbound/source-reply-mirror.js";
import { createTestPluginRegistry } from "../src/plugins/registry-runtime.test-helpers.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../src/plugins/runtime.js";
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
const guildPath = `/guilds/${guildId}`;
const activeThreadsPath = `${guildPath}/threads/active`;
const exactCurrentOnly = "exact current conversation";
const thread = (id: string, parent_id: string, name: string) => ({
  id,
  type: guildPublicThreadType,
  guild_id: guildId,
  parent_id,
  name,
});
const allowedThread = thread(allowedThreadId, current, "Allowed thread");
const activeThreads = [
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
];

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
    `${guildPath}/members/${userId}`,
    { ok: true, member },
    { guildId, userId },
  ),
  metadataRead("role-info", "roleInfo", `${guildPath}/roles`, { ok: true, roles: [role] }),
  metadataRead("emoji-list", "reactions", `${guildPath}/emojis`, {
    ok: true,
    emojis: [
      { name: "alpha", identifier: "alpha:1", animated: true },
      { name: "beta", identifier: "beta:2" },
    ],
  }),
  metadataRead("channel-list", "channelInfo", `${guildPath}/channels`, {
    ok: true,
    channels,
  }),
  metadataRead(
    "voice-status",
    "voiceStatus",
    `${guildPath}/voice-states/${userId}`,
    { ok: true, voice },
    { guildId, userId },
  ),
  metadataRead("event-list", "events", `${guildPath}/scheduled-events`, { ok: true, events }),
];

async function createFixture() {
  const discord: DiscordConfig = {
    enabled: true,
    token: "synthetic-provider-fixture",
    groupPolicy: "allowlist",
    guilds: { [guildId]: { channels: { "*": { enabled: true } } } },
  };
  const cfg: OpenClawConfig = { channels: { discord } };
  const owner = createTestPluginRegistry();
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

  const routes = new Map<string, { body: unknown; status?: number }>();
  const route = (path: string, body: unknown, status?: number) =>
    routes.set(path, { body, status });
  for (const channel of channels) {
    route(`/channels/${channel.id}`, channel);
  }
  route("/users/%40me", { id: botId });
  route(guildPath, { id: guildId, name: "Fixture", roles: [role] });
  route(`${guildPath}/members/${botId}`, { user: { id: botId }, roles: [] });
  route(`${guildPath}/members/${userId}`, member);
  route(`${guildPath}/roles`, [role]);
  route(`${guildPath}/emojis`, [
    { id: "2", name: "beta", roles: [guildId] },
    { id: "1", name: "alpha", animated: true },
    { id: null, name: "unusable" },
  ]);
  route(`${guildPath}/channels`, channels);
  route(activeThreadsPath, {
    threads: activeThreads,
    members: activeThreads.map(({ id }) => ({ id })),
    extra: "guild metadata must not escape",
  });
  route(`${guildPath}/voice-states/${userId}`, voice);
  route(`${guildPath}/scheduled-events`, events);
  route(`/channels/${sibling}/messages`, []);
  route(`/channels/${dmId}`, { id: dmId, type: 1 });
  route("/users/@me/channels", { id: dmId });
  route(`/channels/${dmId}/messages/${messageId}/reactions/%E2%9C%85/@me`, {}, 204);
  route(`/channels/${dmId}/messages`, { id: "100000000000000011", channel_id: dmId });
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
    const reply = routes.get(path);
    response.writeHead(reply?.status ?? (reply ? 200 : 404), {
      "content-type": "application/json",
    });
    response.end(JSON.stringify(reply?.body ?? { message: `Unexpected fixture route: ${path}` }));
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
    route,
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
    action: ChannelMessageActionContext["action"] = fixture.context.action,
    params: ChannelMessageActionContext["params"] = { guildId },
    overrides: Partial<ChannelMessageActionContext> = {},
  ) => dispatchChannelMessageAction({ ...fixture.context, action, params, ...overrides });
  const dispatchDetails = async (...args: Parameters<typeof dispatch>) =>
    (await dispatch(...args))?.details;
  const dispatchDm = (target: string, overrides: Partial<ChannelMessageActionContext> = {}) =>
    dispatchChannelMessageAction({
      ...fixture.dmContext,
      params: { ...fixture.dmContext.params, target, to: target },
      ...overrides,
    });
  const setChannels = (policy: NonNullable<DiscordConfig["guilds"]>[string]["channels"]) => {
    fixture.discord.guilds = { [guildId]: { channels: policy } };
  };
  const expectRejected = async (
    result: Promise<unknown>,
    error: string | RegExp,
    ...paths: string[]
  ) => {
    await expect(result).rejects.toThrow(error);
    expect(fixture.requests).toEqual(paths.map(getRequest));
  };
  const allowCurrentThreads = () => {
    setChannels({ [current]: { enabled: true }, [deniedThreadId]: { enabled: false } });
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
        fixture.route(
          metadata === "malformed" ? activeThreadsPath : `/channels/${current}`,
          metadata === "malformed"
            ? { threads: [{ id: allowedThreadId, parent_id: current }] }
            : { ...channels[0], guild_id: sibling },
        );
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
    await expectRejected(dispatchDm(target), exactCurrentOnly);
  });

  it.each(["account", "provider"])("retains current DM %s restrictions", async (mismatch) => {
    await expectRejected(
      dispatchDm(
        `channel:${dmId}`,
        mismatch === "account"
          ? { requesterAccountId: "other" }
          : { toolContext: { ...fixture.dmContext.toolContext, currentChannelProvider: "slack" } },
      ),
      exactCurrentOnly,
    );
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
    await expectRejected(dispatch(read.action, read.params), "disabled");
  });

  it.each(
    metadataReads.filter(({ action }) =>
      ["role-info", "emoji-list", "channel-list"].includes(action),
    ),
  )("retains guild and wildcard channel restrictions for $action", async (read) => {
    fixture.discord.guilds = {};
    await expectRejected(dispatch(read.action, read.params), "not allowed", guildPath);
    const policies: Array<NonNullable<NonNullable<DiscordConfig["guilds"]>[string]["channels"]>> = [
      { [current]: { enabled: true } },
      { "*": { enabled: true }, [sibling]: { enabled: false } },
    ];
    for (const policy of policies) {
      setChannels(policy);
      await expectRejected(
        dispatch(read.action, read.params),
        "wildcard channel allowlist",
        guildPath,
      );
    }
  });

  it("checks the permissions destination before reading bot permissions", async () => {
    setChannels({ [current]: { enabled: true } });
    await expectRejected(
      dispatch("permissions", { channelId: sibling }),
      "not allowed",
      `/channels/${sibling}`,
    );
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
    await expectRejected(
      fixture.runPermissions(target),
      /channel id is required|resolved to a user target/i,
    );
  });

  it("keeps filtered channel-list relaxation exclusive to direct operators", async () => {
    setChannels({ [sibling]: { enabled: false } });
    await expectRejected(dispatch("channel-list"), "wildcard channel allowlist");
    const result = await dispatchDetails(
      "channel-list",
      { guildId },
      {
        conversationReadOrigin: "direct-operator",
      },
    );
    expect(result).toEqual({ ok: true, channels: [channels[0]] });
  });

  it("rejects a forged operator origin without a current conversation", async () => {
    await expectRejected(
      dispatch(
        "role-info",
        { guildId, conversationReadOrigin: "direct-operator" },
        { toolContext: { currentChannelProvider: "discord" } },
      ),
      "current provider and account context",
    );
  });

  it.each(["unverified", "legacy"] as const)(
    "keeps a %s registration exact-current-only",
    async (mode) => {
      if (mode === "unverified") {
        fixture.record.trustedOfficialInstall = false;
      } else {
        fixture.plugin.actions.readAuthorityActions = undefined;
      }
      await expectRejected(dispatch(), exactCurrentOnly);
    },
  );

  it("retains the original six-action read path and excludes mutations", async () => {
    const params = { channelId: sibling };
    expect(await dispatchDetails("read", params)).toMatchObject({ ok: true, messages: [] });
    const reads = [...fixture.requests];
    for (const action of ["react", "edit", "delete", "pin", "unpin"] as const) {
      await expect(dispatch(action, params)).rejects.toThrow(exactCurrentOnly);
    }
    expect(fixture.requests).toEqual(reads);
  });

  it("requires a token for an uncached metadata request", async () => {
    fixture.discord.token = "";
    vi.stubEnv("DISCORD_BOT_TOKEN", undefined);
    await expectRejected(dispatch(), /token/i);
  });

  it("retains captured authority between permissions lookup requests", async () => {
    fixture.transport.onRequest = () => {
      fixture.record.enabled = false;
    };
    await expectRejected(
      dispatch("permissions", { channelId: sibling }),
      "no longer active",
      `/channels/${sibling}`,
    );
  });

  it.each([200, 403, 429])(
    "rejects stale metadata results, errors and retries (HTTP %s)",
    async (status) => {
      fixture.route(
        `${guildPath}/roles`,
        status === 200 ? [role] : { message: "Fixture error", retry_after: 0 },
        status,
      );
      fixture.transport.onRequest = () => {
        fixture.record.enabled = false;
      };
      await expectRejected(dispatch(), "no longer active", `${guildPath}/roles`);
    },
  );
});
