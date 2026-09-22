import { createServer } from "node:http";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { msteamsPlugin } from "../extensions/msteams/api.js";
import { createOperationalRunInstanceRef } from "../src/agents/admitted-run-context.js";
import { wrapToolWithGatewayCallerIdentity } from "../src/agents/tools/gateway-caller-context.js";
import { createMessageTool } from "../src/agents/tools/message-tool-execution.js";
import type {
  ChannelMessageActionContext,
  ChannelMessageActionName,
} from "../src/channels/plugins/types.js";
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
  origin: "",
  acquireToken: vi.fn<() => Promise<string>>(),
  afterEntry: undefined as (() => void) | undefined,
  onRequest: undefined as (() => void) | undefined,
  membershipType: "standard",
}));

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
      const url = new URL(params.url);
      expect(url.origin).toBe("https://graph.microsoft.com");
      return await actual.fetchWithSsrFGuard({
        ...params,
        url: `${graph.origin}${url.pathname}${url.search}`,
        policy: { allowPrivateNetwork: true },
      });
    },
  };
});

const token = "synthetic-graph-token";
const teamId = "11111111-1111-1111-1111-111111111111";
const currentChannel = "19:current@thread.tacv2";
const targetChannel = "19:target@thread.tacv2";
const chatId = "19:chat@thread.v2";
const requesterId = "22222222-2222-2222-2222-222222222222";
const memberId = "33333333-3333-3333-3333-333333333333";
const messageId = "message-1";
const target = `${teamId}/${targetChannel}`;
const currentTarget = `${teamId}/${currentChannel}`;
const message = {
  id: messageId,
  body: { content: "Permitted Teams context", contentType: "text" },
  from: { user: { id: memberId, displayName: "Member" } },
  reactions: [{ reactionType: "👍", user: { id: memberId } }],
};
type Route = "tool" | "gateway";
type Origin = "bundled" | "global";
let sequence = 0;
const cleanups: Array<() => Promise<void>> = [];

beforeEach(() => {
  graph.acquireToken.mockReset().mockResolvedValue(token);
  graph.afterEntry = undefined;
  graph.onRequest = undefined;
  graph.membershipType = "standard";
});

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) {
    await cleanup();
  }
  resetPluginRuntimeStateForTest();
  clearRuntimeConfigSnapshot();
});

async function createFixture(
  options: {
    origin?: Origin;
    self?: boolean;
    narrowTeam?: boolean;
    legacy?: boolean;
    unverified?: boolean;
  } = {},
) {
  const origin = options.origin ?? "global";
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
        groupPolicy: options.narrowTeam ? "allowlist" : "open",
        teams: {
          [teamId]: { channels: { [options.narrowTeam ? targetChannel : "*"]: {} } },
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
    trustedOfficialInstall: origin === "global" && !options.unverified,
  });
  const providerActions = msteamsPlugin.actions!;
  const plugin = {
    ...msteamsPlugin,
    status: undefined,
    actions: {
      ...providerActions,
      readAuthorityActions: options.legacy ? undefined : providerActions.readAuthorityActions,
      handleAction: async (ctx: ChannelMessageActionContext) => {
        const result = providerActions.handleAction!(ctx);
        graph.afterEntry?.();
        return await result;
      },
    },
  };
  owner.registry.plugins.push(record);
  owner.createApi(record, { config: cfg, registrationMode: "full" }).registerChannel({ plugin });
  setActivePluginRegistry(owner.registry);
  setRuntimeConfigSnapshot(cfg, cfg);

  const sessionKey = "agent:main:msteams:channel:origin";
  const operationalRunInstance = createOperationalRunInstanceRef(`teams-read-${++sequence}`);
  const delegatedAuthority = claimAgentRunDelegatedAuthority(operationalRunInstance);
  const toolContext = {
    currentChannelProvider: "msteams",
    currentChannelId: options.self ? chatId : options.narrowTeam ? targetChannel : currentChannel,
    currentChatType: options.self ? ("direct" as const) : ("channel" as const),
    ...(options.self
      ? {}
      : {
          currentMessagingTarget: options.narrowTeam ? target : currentTarget,
          currentGraphChannelId: options.narrowTeam ? target : currentTarget,
        }),
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
  const requests: string[] = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://fixture.invalid");
    requests.push(`${request.method} ${decodeURIComponent(url.pathname)}`);
    expect(request.headers.authorization).toBe(`Bearer ${token}`);
    request.resume();
    graph.onRequest?.();
    let body: unknown = message;
    if (url.pathname.endsWith("/members")) {
      body = {
        value: [
          { userId: memberId, displayName: "Member", email: "member@example.test", roles: [] },
        ],
      };
    } else if (url.pathname.endsWith("/channels")) {
      body = { value: [{ id: targetChannel, displayName: "Target", membershipType: "standard" }] };
    } else if (url.pathname.includes("/channels/") && !url.pathname.includes("/messages")) {
      body = {
        id: decodeURIComponent(url.pathname.split("/").at(-1)!),
        membershipType: graph.membershipType,
      };
    } else if (url.pathname.endsWith("/pinnedMessages")) {
      body = { value: [{ id: "pin-1", message }] };
    } else if (url.pathname.endsWith("/messages")) {
      body = { value: [message] };
    }
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(body));
  });
  cleanups.push(async () => {
    revokeMessageActionTurnCapability(turnCapability);
    releaseAgentRunDelegatedAuthority(delegatedAuthority);
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    const disposal = await getPluginInstance(record)?.dispose();
    expect(disposal?.errors).toEqual([]);
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected loopback server address");
  }
  graph.origin = `http://127.0.0.1:${address.port}`;
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

  return {
    requests,
    tool,
    revokeTurn: () => revokeMessageActionTurnCapability(turnCapability),
    revokeClaim: () => releaseAgentRunDelegatedAuthority(delegatedAuthority),
    retirePlugin: () => {
      record.enabled = false;
    },
    async invoke(route: Route, action: ChannelMessageActionName, params: Record<string, unknown>) {
      if (route === "tool") {
        return (
          await tool.execute(`teams-call-${++sequence}`, { action, channel: "msteams", ...params })
        ).details;
      }
      const respond =
        vi.fn<(ok: boolean, payload?: unknown, error?: { message?: string }) => void>();
      await sendHandlers["message.action"]!({
        params: {
          action,
          channel: "msteams",
          params,
          agentId: "main",
          sessionKey,
          idempotencyKey: `teams-call-${++sequence}`,
        },
        respond,
        context,
        client,
        req: { type: "req", id: `teams-rpc-${sequence}`, method: "message.action" },
        isWebchatConnect: () => false,
      });
      expect(respond).toHaveBeenCalledTimes(1);
      const [ok, payload, error] = respond.mock.calls[0]!;
      if (!ok) {
        expect(payload).toBeUndefined();
        throw new Error(error?.message ?? "Gateway Teams action failed");
      }
      return payload;
    },
  };
}

const surfaces = [
  ["tool", "bundled"],
  ["tool", "global"],
  ["gateway", "bundled"],
  ["gateway", "global"],
] as const;

// Registry provenance is an explicit fixture; package installation is proved separately.
describe.each(surfaces)("Teams %s reads with a %s registration", (route, origin) => {
  it("runs all seven existing read actions", async () => {
    const fixture = await createFixture({ origin });
    const messagePath = `/v1.0/teams/${teamId}/channels/${targetChannel}/messages/${messageId}`;
    const cases: Array<{
      action: ChannelMessageActionName;
      params: Record<string, unknown>;
      payload: Record<string, unknown>;
      requests: string[];
    }> = [
      {
        action: "read",
        params: { target, messageId },
        payload: { message: { id: messageId, text: message.body.content } },
        requests: [`GET ${messagePath}`],
      },
      {
        action: "reactions",
        params: { target, messageId },
        payload: { reactions: [{ reactionType: "👍", count: 1, users: [{ id: memberId }] }] },
        requests: [`GET ${messagePath}`],
      },
      {
        action: "list-pins",
        params: { target: chatId },
        payload: { pins: [{ pinnedMessageId: "pin-1", messageId, text: message.body.content }] },
        requests: [`GET /v1.0/chats/${chatId}/pinnedMessages`],
      },
      {
        action: "search",
        params: { query: "permitted" },
        payload: { messages: [{ id: messageId, text: message.body.content }], truncated: false },
        requests: [`GET /v1.0/teams/${teamId}/channels/${currentChannel}/messages`],
      },
      {
        action: "member-info",
        params: { userId: memberId },
        payload: { user: { id: memberId, displayName: "Member", roles: [] } },
        requests: [
          `GET /v1.0/teams/${teamId}/channels/${currentChannel}`,
          `GET /v1.0/teams/${teamId}/members`,
        ],
      },
      {
        action: "channel-info",
        params: { teamId, channelId: targetChannel },
        payload: { channelInfo: { id: targetChannel, membershipType: "standard" } },
        requests: [`GET /v1.0/teams/${teamId}/channels/${targetChannel}`],
      },
      {
        action: "channel-list",
        params: { teamId },
        payload: { channels: [{ id: targetChannel, displayName: "Target" }], truncated: false },
        requests: [`GET /v1.0/teams/${teamId}/channels`],
      },
    ];
    for (const testCase of cases) {
      const before = fixture.requests.length;
      await expect(
        fixture.invoke(route, testCase.action, testCase.params),
        testCase.action,
      ).resolves.toMatchObject({
        ok: true,
        channel: "msteams",
        action: testCase.action,
        ...testCase.payload,
      });
      expect(fixture.requests.slice(before), testCase.action).toEqual(testCase.requests);
    }
  });

  it.each(["turn", "plugin"] as const)("stops a held token when the %s closes", async (owner) => {
    const fixture = await createFixture({ origin });
    const started = createDeferred<void>();
    const finish = createDeferred<void>();
    graph.acquireToken.mockImplementation(async () => {
      started.resolve();
      await finish.promise;
      return token;
    });
    const result = fixture.invoke(route, "read", { target, messageId });
    const rejected = expect(result).rejects.toThrow(/no longer active|authority/i);
    await started.promise;
    if (owner === "turn") {
      fixture.revokeTurn();
    } else {
      fixture.retirePlugin();
    }
    finish.resolve();
    await rejected;
    expect(fixture.requests).toEqual([]);
  });

  it("withholds a result when the admitted run closes during Graph I/O", async () => {
    const fixture = await createFixture({ origin });
    graph.onRequest = fixture.revokeClaim;
    await expect(fixture.invoke(route, "read", { target, messageId })).rejects.toThrow(
      /no longer active|authority/i,
    );
    expect(fixture.requests).toHaveLength(1);
  });

  it.each([false, true])(
    "fences the local requester-only member result (revoked=%s)",
    async (revoked) => {
      const fixture = await createFixture({ origin, self: true });
      if (revoked) {
        graph.afterEntry = fixture.retirePlugin;
      }
      const result = fixture.invoke(route, "member-info", { userId: requesterId });
      if (revoked) {
        await expect(result).rejects.toThrow(/no longer active|authority/i);
      } else {
        await expect(result).resolves.toMatchObject({ user: { id: requesterId, roles: [] } });
      }
      expect(fixture.requests).toEqual([]);
      expect(graph.acquireToken).not.toHaveBeenCalled();
    },
  );
});

describe.each(["tool", "gateway"] as const)("Teams %s policy controls", (route) => {
  it.each(["legacy", "unverified"] as const)(
    "does not grant cross-conversation reads to a %s adapter",
    async (kind) => {
      const fixture = await createFixture({ [kind]: true });
      await expect(fixture.invoke(route, "read", { target, messageId })).rejects.toThrow(
        /exact current conversation/i,
      );
      expect(fixture.requests).toEqual([]);
    },
  );

  it("rejects an unknown account before Graph", async () => {
    const fixture = await createFixture();
    await expect(
      fixture.invoke(route, "read", { target, messageId, accountId: "other" }),
    ).rejects.toThrow(/account/i);
    expect(fixture.requests).toEqual([]);
  });

  it("keeps private-channel membership outside the supported permission baseline", async () => {
    const fixture = await createFixture();
    graph.membershipType = "private";
    await expect(fixture.invoke(route, "member-info", { userId: memberId })).rejects.toThrow(
      /standard channel/,
    );
    expect(fixture.requests).toHaveLength(1);
    expect(fixture.requests[0]).not.toContain("/members");
  });

  it("keeps one allowed channel scoped to that conversation", async () => {
    const fixture = await createFixture({ narrowTeam: true });
    await expect(fixture.invoke(route, "read", { target, messageId })).resolves.toMatchObject({
      ok: true,
    });
    await expect(
      fixture.invoke(route, "read", { target: currentTarget, messageId }),
    ).rejects.toThrow(/not allowed/);
    await expect(fixture.invoke(route, "channel-list", { teamId })).rejects.toThrow(
      /every channel/,
    );
    expect(fixture.requests).toHaveLength(1);
  });
});
