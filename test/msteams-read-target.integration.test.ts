import { createServer } from "node:http";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { msteamsPlugin } from "../extensions/msteams/api.js";
import { createOperationalRunInstanceRef } from "../src/agents/admitted-run-context.js";
import { wrapToolWithGatewayCallerIdentity } from "../src/agents/tools/gateway-caller-context.js";
import { createMessageTool } from "../src/agents/tools/message-tool-execution.js";
import { dispatchChannelMessageAction } from "../src/channels/plugins/message-action-dispatch.js";
import type { ChannelThreadingToolContext } from "../src/channels/plugins/types.public.js";
import { createDefaultDeps } from "../src/cli/deps.js";
import { createMessageCliHelpers } from "../src/cli/program/message/helpers.js";
import { registerMessageDiscordAdminCommands } from "../src/cli/program/message/register.discord-admin.js";
import { messageCommand } from "../src/commands/message.js";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../src/config/config.js";
import type { OpenClawConfig } from "../src/config/types.js";
import { createAgentRuntimeApprovalAuthorityValidator } from "../src/gateway/agent-runtime-identity-token.js";
import {
  mintMessageActionTurnCapability,
  resolveMessageActionTurnCapability,
  revokeMessageActionTurnCapability,
} from "../src/gateway/message-action-turn-capability.js";
import { sendHandlers } from "../src/gateway/server-methods/send.js";
import type { GatewayClient, GatewayRequestContext } from "../src/gateway/server-methods/types.js";
import {
  claimAgentRunDelegatedAuthority,
  releaseAgentRunDelegatedAuthority,
  validateAgentRunDelegatedAuthority,
} from "../src/infra/agent-run-registry.js";
import { getPluginInstance } from "../src/plugins/plugin-instance-scope.js";
import { createPluginRegistry } from "../src/plugins/registry.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../src/plugins/runtime.js";
import type { PluginRuntime } from "../src/plugins/runtime/types.js";
import { createPluginRecord } from "../src/plugins/status.test-fixtures.js";

const graph = vi.hoisted(() => ({
  endpoint: undefined as { origin: string; signal: AbortSignal } | undefined,
  acquireToken: vi.fn<() => Promise<string>>(),
}));

// Only token acquisition and the physical Graph origin are fixtures. Target
// selection, authorization, Graph reads, and response decoding remain real.
vi.mock("../extensions/msteams/src/sdk.js", () => ({
  async loadMSTeamsSdkWithAuth() {
    return { app: {} };
  },
  createMSTeamsTokenProvider() {
    return { getAccessToken: graph.acquireToken };
  },
}));

vi.mock("../extensions/msteams/runtime-api.js", async (original) => {
  const actual = await original<typeof import("../extensions/msteams/runtime-api.js")>();
  return {
    ...actual,
    async fetchWithSsrFGuard(params: Parameters<typeof actual.fetchWithSsrFGuard>[0]) {
      const endpoint = graph.endpoint;
      if (!endpoint) {
        throw new Error("Graph fixture is not active");
      }
      endpoint.signal.throwIfAborted();
      const url = new URL(params.url);
      expect(url.origin).toBe("https://graph.microsoft.com");
      const signal = params.signal ?? params.init?.signal;
      return await actual.fetchWithSsrFGuard({
        ...params,
        url: `${endpoint.origin}${url.pathname}${url.search}`,
        signal: signal ? AbortSignal.any([endpoint.signal, signal]) : endpoint.signal,
        policy: { allowPrivateNetwork: true },
      });
    },
  };
});

const token = "synthetic-graph-token";
const requesterId = "22222222-2222-2222-2222-222222222222";
const memberId = "33333333-3333-3333-3333-333333333333";
const current = {
  teamId: "11111111-1111-1111-1111-111111111111",
  channelId: "19:current@thread.tacv2",
  messageId: "current-message",
  text: "Current planning notes",
  roles: [] as string[],
};
const other = {
  teamId: "66666666-6666-6666-6666-666666666666",
  channelId: "19:other@thread.tacv2",
  messageId: "other-message",
  text: "Other planning notes",
  roles: ["owner"],
};
const currentTarget = `${current.teamId}/${current.channelId}`;
const otherTarget = `${other.teamId}/${other.channelId}`;
const currentChat = "19:current-chat@thread.v2";
const otherChat = "19:other-chat@thread.v2";
const deniedTarget = `${other.teamId}/19:denied@thread.tacv2`;
type Action = "search" | "member-info";
type Route = "tool" | "gateway";
type Destination = typeof current;
type GraphRequest = { method: string | undefined; path: string; authorization: string | undefined };
const cleanups: Array<() => Promise<void>> = [];
let sequence = 0;

beforeEach(() => {
  if (graph.endpoint) {
    throw new Error("The previous Graph fixture has unfinished work");
  }
  graph.acquireToken.mockReset().mockResolvedValue(token);
});

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) {
    await cleanup();
  }
  resetPluginRuntimeStateForTest();
  clearRuntimeConfigSnapshot();
});

async function createFixture(
  currentContext: "channel" | "chat" | "none" = "channel",
  origin: "bundled" | "global" = "bundled",
) {
  const cfg: OpenClawConfig = {
    channels: {
      msteams: {
        enabled: true,
        authType: "secret",
        appId: "44444444-4444-4444-4444-444444444444",
        appPassword: "synthetic-app-password",
        tenantId: "55555555-5555-5555-5555-555555555555",
        dmPolicy: "open",
        allowFrom: ["*"],
        groupPolicy: currentContext === "chat" ? "open" : "allowlist",
        teams: {
          [current.teamId]: { channels: { [current.channelId]: {} } },
          [other.teamId]: { channels: { [other.channelId]: {} } },
        },
      },
    },
  };
  const owner = createPluginRegistry({
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    runtime: {} as PluginRuntime,
    activateGlobalSideEffects: false,
  });
  const record = createPluginRecord({
    id: "msteams",
    origin,
    trustedOfficialInstall: origin === "global",
  });
  owner.registry.plugins.push(record);
  owner.createApi(record, { config: cfg, registrationMode: "full" }).registerChannel({
    plugin: { ...msteamsPlugin, status: undefined },
  });
  setActivePluginRegistry(owner.registry);
  setRuntimeConfigSnapshot(cfg, cfg);

  const sessionKey = "agent:main:msteams:channel:origin";
  const operationalRunInstance = createOperationalRunInstanceRef(`teams-target-${++sequence}`);
  const delegatedAuthority = claimAgentRunDelegatedAuthority(operationalRunInstance);
  const toolContext: ChannelThreadingToolContext | undefined =
    currentContext === "none"
      ? undefined
      : {
          ...msteamsPlugin.threading!.buildToolContext!({
            cfg,
            accountId: "default",
            context: {
              To: `conversation:${currentContext === "chat" ? currentChat : current.channelId}`,
              ChatType: currentContext === "chat" ? "direct" : "channel",
              NativeChannelId: currentContext === "chat" ? undefined : currentTarget,
            },
            hasRepliedRef: { value: false },
          }),
          currentChannelProvider: "msteams",
        };
  const capabilityParams = { agentId: "main", runId: operationalRunInstance.runId, sessionKey };
  const turnCapability = mintMessageActionTurnCapability({
    ...capabilityParams,
    requesterAccountId: "default",
    requesterSenderId: requesterId,
    toolContext,
  });
  const messageActionContext = resolveMessageActionTurnCapability({
    ...capabilityParams,
    token: turnCapability,
  });
  if (!messageActionContext) {
    throw new Error("Expected an admitted Teams turn");
  }
  const client = {
    internal: {
      agentRuntimeIdentity: {
        kind: "agentRuntime",
        agentId: "main",
        sessionKey,
        operationalRunInstance,
        delegatedAuthority: { kind: "local", ...delegatedAuthority },
        messageActionContext: { ...messageActionContext, turnCapability },
      },
    },
  } as GatewayClient;
  const context = {
    dedupe: new Map(),
    getRuntimeConfig: () => cfg,
    validateAgentRuntimeApprovalAuthority: createAgentRuntimeApprovalAuthorityValidator(),
  } as GatewayRequestContext;
  const requests: GraphRequest[] = [];
  const controller = new AbortController();
  const pending = new Set<Promise<unknown>>();
  const server = createServer((request, response) => {
    const path = decodeURIComponent(new URL(request.url ?? "/", "http://fixture.invalid").pathname);
    requests.push({ method: request.method, path, authorization: request.headers.authorization });
    request.resume();
    const destination = [current, other].find((candidate) =>
      path.startsWith(`/v1.0/teams/${candidate.teamId}/`),
    );
    let body: unknown;
    if (destination && path === `/v1.0/teams/${destination.teamId}/members`) {
      body = {
        value: [
          {
            userId: memberId,
            displayName: "Member",
            email: "member@example.test",
            roles: destination.roles,
          },
        ],
      };
    } else if (
      destination &&
      path === `/v1.0/teams/${destination.teamId}/channels/${destination.channelId}`
    ) {
      body = { id: destination.channelId, membershipType: "standard" };
    } else if (
      destination &&
      path === `/v1.0/teams/${destination.teamId}/channels/${destination.channelId}/messages`
    ) {
      body = {
        value: [
          {
            id: destination.messageId,
            body: { content: destination.text, contentType: "text" },
          },
        ],
      };
    } else {
      response.statusCode = 404;
      body = { error: { message: "Unexpected Graph fixture route" } };
    }
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(body));
  });
  cleanups.push(async () => {
    controller.abort(new Error("Teams fixture closed"));
    revokeMessageActionTurnCapability(turnCapability);
    releaseAgentRunDelegatedAuthority(delegatedAuthority);
    server.closeAllConnections();
    await Promise.allSettled(pending);
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    await getPluginInstance(record)?.dispose();
    graph.endpoint = undefined;
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected a loopback Graph fixture address");
  }
  graph.endpoint = { origin: `http://127.0.0.1:${address.port}`, signal: controller.signal };
  const tool = wrapToolWithGatewayCallerIdentity(
    createMessageTool({
      ...capabilityParams,
      ...toolContext,
      agentSessionKey: sessionKey,
      agentAccountId: "default",
      messageActionTurnCapability: turnCapability,
      config: cfg,
      getScopedChannelsCommandSecretTargets: () => ({ targetIds: new Set<string>() }),
      resolveCommandSecretRefsViaGateway: async ({ config }) => ({
        resolvedConfig: config,
        diagnostics: [],
        targetStatesByPath: {},
        hadUnresolvedTargets: false,
      }),
    }),
    {
      ...capabilityParams,
      operationalRunInstance,
      receiptAuthority: () => validateAgentRunDelegatedAuthority(delegatedAuthority),
    },
  );
  function retain<T>(operation: () => Promise<T>): Promise<T> {
    const result = Promise.resolve().then(() => {
      controller.signal.throwIfAborted();
      return operation();
    });
    pending.add(result);
    void result.then(
      () => pending.delete(result),
      () => pending.delete(result),
    );
    return result;
  }

  return {
    requests,
    invoke(route: Route, action: Action, params: Record<string, unknown> = {}) {
      return retain(async () => {
        const actionParams = { ...inputFor(action), ...params };
        if (route === "tool") {
          return (
            await tool.execute(
              `teams-call-${++sequence}`,
              { action, channel: "msteams", ...actionParams },
              controller.signal,
            )
          ).details;
        }
        const respond =
          vi.fn<(ok: boolean, payload?: unknown, error?: { message?: string }) => void>();
        await sendHandlers["message.action"]!({
          params: {
            action,
            channel: "msteams",
            params: actionParams,
            agentId: "main",
            sessionKey,
            idempotencyKey: `teams-call-${++sequence}`,
          },
          respond,
          context,
          client,
          req: { type: "req", id: `teams-rpc-${sequence}`, method: "message.action" },
          isWebchatConnect: () => false,
          signal: controller.signal,
        });
        expect(respond).toHaveBeenCalledTimes(1);
        const [ok, payload, error] = respond.mock.calls[0]!;
        if (!ok) {
          expect(payload).toBeUndefined();
          throw new Error(error?.message ?? "Gateway Teams action failed");
        }
        return payload;
      });
    },
    invokeAdapter(action: Action, params: Record<string, unknown>) {
      return retain(async () => {
        const result = await dispatchChannelMessageAction({
          cfg,
          channel: "msteams",
          action,
          params: { ...inputFor(action), ...params },
          accountId: "default",
          requesterAccountId: "default",
          requesterSenderId: requesterId,
          conversationReadOrigin: "delegated",
          toolContext,
        });
        expect(result).not.toBeNull();
        return result?.details;
      });
    },
  };
}

function inputFor(action: Action): Record<string, unknown> {
  return action === "search" ? { query: "planning", limit: 1 } : { userId: memberId };
}

function expectReadResult(result: unknown, action: Action, destination: Destination) {
  expect(result).toMatchObject({
    ok: true,
    channel: "msteams",
    action,
    ...(action === "search"
      ? { messages: [{ id: destination.messageId, text: destination.text }], truncated: false }
      : {
          user: {
            id: memberId,
            displayName: "Member",
            mail: "member@example.test",
            roles: destination.roles,
          },
        }),
  });
}

function expectGraphRequests(requests: GraphRequest[], action: Action, destination: Destination) {
  const channelPath = `/v1.0/teams/${destination.teamId}/channels/${destination.channelId}`;
  const paths =
    action === "search"
      ? [`${channelPath}/messages`]
      : [channelPath, `/v1.0/teams/${destination.teamId}/members`];
  expect(requests).toEqual(
    paths.map((path) => ({ method: "GET", path, authorization: `Bearer ${token}` })),
  );
}

describe("Teams member info CLI", () => {
  it("reads a selected channel member without current conversation context", async () => {
    const fixture = await createFixture("none");
    const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
    const command = new Command().name("message").exitOverride();
    registerMessageDiscordAdminCommands(command, {
      ...createMessageCliHelpers("msteams"),
      runMessageAction: async (action, opts) => {
        await messageCommand({ ...opts, action }, createDefaultDeps(), runtime);
      },
    });

    await command.parseAsync(
      [
        "member",
        "info",
        "--channel",
        "msteams",
        "--user-id",
        memberId,
        "--channel-id",
        otherTarget,
        "--json",
      ],
      { from: "user" },
    );

    expect(runtime.log).toHaveBeenCalledTimes(1);
    expect(runtime.error).not.toHaveBeenCalled();
    const result = JSON.parse(String(runtime.log.mock.calls[0]?.[0]));
    expect(result).toMatchObject({
      action: "member-info",
      channel: "msteams",
      dryRun: false,
      handledBy: "plugin",
    });
    expectReadResult(result.payload, "member-info", other);
    expectGraphRequests(fixture.requests, "member-info", other);
  });
});

describe.each(["tool", "gateway"] as const)("Teams %s read target selection", (route) => {
  describe.each(["search", "member-info"] as const)("%s", (action) => {
    describe.each(["bundled", "global"] as const)("%s registration", (origin) => {
      it.each([
        { name: "omitted", channelId: undefined },
        { name: "bare", channelId: current.channelId },
        { name: "conversation-prefixed", channelId: `conversation:${current.channelId}` },
        { name: "provider-prefixed", channelId: `msteams:${current.channelId}` },
        { name: "provider alias", channelId: `teams:conversation:${current.channelId}` },
        { name: "thread-qualified", channelId: `conversation:${current.channelId};messageid=123` },
        { name: "Graph", channelId: currentTarget },
      ])("reads the current channel with a $name target", async ({ channelId }) => {
        const fixture = await createFixture("channel", origin);
        const result = await fixture.invoke(route, action, channelId ? { channelId } : {});
        expectReadResult(result, action, current);
        expectGraphRequests(fixture.requests, action, current);
      });
    });

    it("uses an explicit permitted channelId instead of the current channel", async () => {
      const fixture = await createFixture();
      const result = await fixture.invoke(route, action, { channelId: otherTarget });
      expectReadResult(result, action, other);
      expectGraphRequests(fixture.requests, action, other);
    });

    it("uses an explicit channelId without current conversation context", async () => {
      const fixture = await createFixture("none");
      const result = await fixture.invoke(route, action, { channelId: otherTarget });
      expectReadResult(result, action, other);
      expectGraphRequests(fixture.requests, action, other);
    });

    it("preserves the missing-target error when no current context exists", async () => {
      const fixture = await createFixture("none");
      await expect(fixture.invoke(route, action)).resolves.toEqual({
        error: `${action === "search" ? "Search" : "member-info"} requires a target (to).`,
      });
      expect(fixture.requests).toEqual([]);
      expect(graph.acquireToken).not.toHaveBeenCalled();
    });

    it.each([
      { name: "unconfigured channel", channelId: deniedTarget },
      {
        name: "channel paired with the wrong team",
        channelId: `${other.teamId}/${current.channelId}`,
      },
      { name: "case-distinct conversation", channelId: "19:CURRENT@thread.tacv2" },
      { name: "user-prefixed conversation", channelId: `user:${current.channelId}` },
    ])(
      "rejects an explicit $name instead of reading the current channel",
      async ({ channelId }) => {
        const fixture = await createFixture();
        await expect(fixture.invoke(route, action, { channelId })).rejects.toThrow(/not allowed/i);
        expect(fixture.requests).toEqual([]);
        expect(graph.acquireToken).not.toHaveBeenCalled();
      },
    );

    it.each([current.channelId, otherTarget])(
      "rejects an unknown account for %s",
      async (channelId) => {
        const fixture = await createFixture();
        await expect(
          fixture.invoke(route, action, { channelId, accountId: "other" }),
        ).rejects.toThrow(/account/i);
        expect(fixture.requests).toEqual([]);
      },
    );
  });

  it("keeps the requester-only member shortcut in the current chat", async () => {
    const fixture = await createFixture("chat");
    await expect(
      fixture.invoke(route, "member-info", { userId: requesterId }),
    ).resolves.toMatchObject({ ok: true, user: { id: requesterId, roles: [] } });
    await expect(
      fixture.invoke(route, "member-info", { channelId: otherChat, userId: requesterId }),
    ).rejects.toThrow(/is not a member of this conversation/i);
    expect(fixture.requests).toEqual([]);
    expect(graph.acquireToken).not.toHaveBeenCalled();
  });
});

describe.each(["search", "member-info"] as const)(
  "registered Teams %s adapter inputs",
  (action) => {
    it("preserves to, then target precedence ahead of channelId", async () => {
      const fixture = await createFixture();
      for (const [params, destination] of [
        [{ to: currentTarget, target: otherTarget, channelId: deniedTarget }, current],
        [{ target: otherTarget, channelId: deniedTarget }, other],
        [{ to: otherTarget, target: current.channelId, channelId: current.channelId }, other],
        [{ target: current.channelId, channelId: otherTarget }, current],
      ] as const) {
        const before = fixture.requests.length;
        const result = await fixture.invokeAdapter(action, params);
        expectReadResult(result, action, destination);
        expectGraphRequests(fixture.requests.slice(before), action, destination);
      }
    });
  },
);
