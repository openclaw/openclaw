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
import { createAgentRuntimeApprovalAuthorityValidator } from "../src/gateway/agent-runtime-approval-authority.js";
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

type GraphRequest = { method: string; url: URL; body: unknown };
type GraphReply = { status?: number; headers?: Record<string, string>; body?: unknown };

const graph = vi.hoisted(() => ({
  origin: "",
  prepareSdk: vi.fn<() => Promise<void>>(),
  acquireToken: vi.fn<() => Promise<string>>(),
  afterEntry: undefined as (() => void) | undefined,
  beforeLookup: undefined as (() => void | Promise<void>) | undefined,
  onRequest: undefined as ((request: GraphRequest) => void) | undefined,
  reply: undefined as ((request: GraphRequest) => GraphReply | undefined) | undefined,
  membershipType: "standard",
}));

vi.mock("../extensions/msteams/src/sdk.js", () => ({
  async loadMSTeamsSdkWithAuth() {
    await graph.prepareSdk();
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
        lookupFn: async () => {
          await graph.beforeLookup?.();
          return [{ address: "127.0.0.1", family: 4 }];
        },
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
const membershipId = "membership-1";
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
  graph.prepareSdk.mockReset().mockResolvedValue(undefined);
  graph.acquireToken.mockReset().mockResolvedValue(token);
  graph.afterEntry = undefined;
  graph.beforeLookup = undefined;
  graph.onRequest = undefined;
  graph.reply = undefined;
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
    senderIsOwner?: boolean;
    botFrameworkTeam?: boolean;
    missingRequester?: boolean;
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
        groupPolicy: options.narrowTeam || options.botFrameworkTeam ? "allowlist" : "open",
        teams: {
          [options.botFrameworkTeam ? currentChannel : teamId]: {
            channels: {
              [options.narrowTeam || options.botFrameworkTeam ? targetChannel : "*"]: {},
            },
          },
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
  const providerSettlements: Array<{
    action: ChannelMessageActionName;
    result?: unknown;
    error?: unknown;
  }> = [];
  const plugin = {
    ...msteamsPlugin,
    status: undefined,
    actions: {
      ...providerActions,
      readAuthorityActions: options.legacy ? undefined : providerActions.readAuthorityActions,
      handleAction: async (ctx: ChannelMessageActionContext) => {
        try {
          const pending = providerActions.handleAction!(ctx);
          graph.afterEntry?.();
          const result = await pending;
          providerSettlements.push({ action: ctx.action, result });
          return result;
        } catch (error) {
          providerSettlements.push({ action: ctx.action, error });
          throw error;
        }
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
    requesterSenderId: options.missingRequester ? undefined : requesterId,
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
  const nativeRequests: GraphRequest[] = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://fixture.invalid");
    requests.push(`${request.method} ${decodeURIComponent(url.pathname)}`);
    expect(request.headers.authorization).toBe(`Bearer ${token}`);
    let requestBody = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      requestBody += chunk;
    });
    request.on("end", () => {
      const nativeRequest = {
        method: request.method ?? "GET",
        url,
        body: requestBody ? (JSON.parse(requestBody) as unknown) : undefined,
      };
      nativeRequests.push(nativeRequest);
      graph.onRequest?.(nativeRequest);
      const reply = graph.reply?.(nativeRequest);
      if (reply) {
        response.writeHead(reply.status ?? 200, {
          "content-type": "application/json",
          ...reply.headers,
        });
        response.end(reply.body === undefined ? undefined : JSON.stringify(reply.body));
        return;
      }
      let body: unknown = message;
      if (url.pathname.endsWith("/members")) {
        body = {
          value: [
            {
              id: membershipId,
              userId: memberId,
              displayName: "Member",
              email: "member@example.test",
              roles: [],
            },
          ],
        };
      } else if (url.pathname.endsWith("/channels")) {
        body = {
          value: [{ id: targetChannel, displayName: "Target", membershipType: "standard" }],
        };
      } else if (url.pathname.includes("/channels/") && !url.pathname.includes("/messages")) {
        body = {
          id: decodeURIComponent(url.pathname.split("/").at(-1)!),
          membershipType: graph.membershipType,
        };
      } else if (url.pathname.endsWith("/pinnedMessages")) {
        body = request.method === "POST" ? { id: "pin-1" } : { value: [{ id: "pin-1", message }] };
      } else if (url.pathname.endsWith("/messages")) {
        body = { value: [message] };
      }
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(body));
    });
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
  graph.origin = `http://msteams-proof.invalid:${address.port}`;
  const tool = wrapToolWithGatewayCallerIdentity(
    createMessageTool({
      ...capabilityParams,
      ...toolContext,
      agentSessionKey: sessionKey,
      agentAccountId: "default",
      senderIsOwner: options.senderIsOwner,
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
    nativeRequests,
    providerSettlements,
    tool,
    revokeTurn: () => revokeMessageActionTurnCapability(turnCapability),
    revokeClaim: () => releaseAgentRunDelegatedAuthority(delegatedAuthority),
    retirePlugin: () => {
      record.enabled = false;
    },
    async invoke(
      route: Route,
      action: ChannelMessageActionName,
      params: Record<string, unknown>,
      signal?: AbortSignal,
    ) {
      if (route === "tool") {
        return (
          await tool.execute(
            `teams-call-${++sequence}`,
            { action, channel: "msteams", ...params },
            signal,
          )
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

function settle<T>(pending: Promise<T>) {
  return pending.then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
}

describe("Teams Graph mutation currentness", () => {
  const chatPath = `/v1.0/chats/${chatId}`;
  const mutationCases: Array<{
    name: string;
    action: ChannelMessageActionName;
    params: Record<string, unknown>;
    details: Record<string, unknown>;
    requests: string[];
  }> = [
    {
      name: "pin",
      action: "pin",
      params: { messageId },
      details: { pinnedMessageId: "pin-1" },
      requests: [`POST ${chatPath}/pinnedMessages`],
    },
    {
      name: "unpin",
      action: "unpin",
      params: { pinnedMessageId: "pin-1" },
      details: {},
      requests: [`DELETE ${chatPath}/pinnedMessages/pin-1`],
    },
    {
      name: "reaction addition",
      action: "react",
      params: { messageId, emoji: "like" },
      details: { reactionType: "like" },
      requests: [`POST /beta/chats/${chatId}/messages/${messageId}/setReaction`],
    },
    {
      name: "reaction removal",
      action: "react",
      params: { messageId, emoji: "like", remove: true },
      details: { reactionType: "like", removed: true },
      requests: [`POST /beta/chats/${chatId}/messages/${messageId}/unsetReaction`],
    },
    {
      name: "participant addition",
      action: "addParticipant",
      params: { userId: memberId },
      details: { added: { userId: memberId, chatId } },
      requests: [`POST ${chatPath}/members`],
    },
    {
      name: "participant removal",
      action: "removeParticipant",
      params: { userId: memberId },
      details: { removed: { userId: memberId, chatId } },
      requests: [`GET ${chatPath}/members`, `DELETE ${chatPath}/members/${membershipId}`],
    },
    {
      name: "rename",
      action: "renameGroup",
      params: { name: "Renamed chat" },
      details: { renamed: { chatId, newName: "Renamed chat" } },
      requests: [`PATCH ${chatPath}`],
    },
  ];

  it.each(
    mutationCases.flatMap((testCase) => [false, true].map((revoked) => ({ testCase, revoked }))),
  )(
    "checks the admitted $testCase.name after a token wait (revoked=$revoked)",
    async ({ testCase: { action, params, details, requests }, revoked }) => {
      const fixture = await createFixture({ origin: "bundled", self: true, senderIsOwner: true });
      const started = createDeferred<void>();
      const finish = createDeferred<void>();
      graph.acquireToken.mockImplementation(async () => {
        started.resolve();
        await finish.promise;
        return token;
      });
      const result = settle(fixture.invoke("tool", action, { target: chatId, ...params }));
      await started.promise;
      if (revoked) {
        fixture.revokeTurn();
      }
      finish.resolve();
      const settled = await result;

      // The outer tool can reject after Graph has written; observe the native request itself.
      expect(fixture.requests).toEqual(revoked ? [] : requests);
      expect(settled).toMatchObject(
        revoked ? { error: expect.any(Error) } : { value: { ok: true, action, ...details } },
      );
      expect(fixture.providerSettlements).toMatchObject([
        revoked
          ? { action, error: expect.any(Error) }
          : { action, result: { details: { ok: true, action, ...details } } },
      ]);
      if (!revoked && action === "addParticipant") {
        expect(fixture.nativeRequests[0]?.body).toMatchObject({ roles: ["owner"] });
      }
    },
  );

  it.each([
    ["sdk", false],
    ["sdk", true],
    ["dns", false],
    ["dns", true],
  ] as const)("rechecks after held %s preparation (revoked=%s)", async (stage, revoked) => {
    const fixture = await createFixture({ origin: "bundled", self: true });
    const started = createDeferred<void>();
    const finish = createDeferred<void>();
    const hold = async () => {
      started.resolve();
      await finish.promise;
    };
    if (stage === "sdk") {
      graph.prepareSdk.mockImplementation(hold);
    } else {
      graph.beforeLookup = hold;
    }
    const result = settle(fixture.invoke("tool", "pin", { target: chatId, messageId }));
    await started.promise;
    if (revoked) {
      fixture.revokeTurn();
    }
    finish.resolve();
    expect(await result).toMatchObject(
      revoked ? { error: expect.any(Error) } : { value: { pinnedMessageId: "pin-1" } },
    );
    expect(fixture.requests).toEqual(revoked ? [] : [`POST ${chatPath}/pinnedMessages`]);
    if (stage === "sdk" && revoked) {
      expect(graph.acquireToken).not.toHaveBeenCalled();
    }
  });

  it.each([
    [307, false],
    [307, true],
    [308, false],
    [308, true],
  ] as const)(
    "checks a same-origin %s redirect before replay (revoked=%s)",
    async (status, revoked) => {
      const fixture = await createFixture({ origin: "bundled", self: true });
      graph.reply = ({ url }) =>
        decodeURIComponent(url.pathname) === `${chatPath}/pinnedMessages`
          ? { status, headers: { location: "/v1.0/redirected/pinnedMessages" } }
          : undefined;
      if (revoked) {
        graph.onRequest = fixture.revokeTurn;
      }
      const result = await settle(fixture.invoke("tool", "pin", { target: chatId, messageId }));
      expect(fixture.requests).toEqual([
        `POST ${chatPath}/pinnedMessages`,
        ...(!revoked ? ["POST /v1.0/redirected/pinnedMessages"] : []),
      ]);
      expect(result).toMatchObject(
        revoked ? { error: expect.any(Error) } : { value: { pinnedMessageId: "pin-1" } },
      );
      if (!revoked) {
        const expectedBody = {
          "message@odata.bind": `https://graph.microsoft.com/v1.0/chats/${encodeURIComponent(chatId)}/messages/${messageId}`,
        };
        expect(fixture.nativeRequests.map((request) => request.body)).toEqual([
          expectedBody,
          expectedBody,
        ]);
      }
    },
  );

  it.each([0, 1, 2])(
    "checks member pages and the final DELETE (close caller after page %s)",
    async (stopAfter) => {
      const fixture = await createFixture({ origin: "bundled", self: true, senderIsOwner: true });
      graph.reply = ({ method, url }) => {
        if (method !== "GET") {
          return undefined;
        }
        return {
          body: url.searchParams.has("$skiptoken")
            ? { value: [{ id: membershipId, userId: memberId }] }
            : {
                value: [{ id: "other-membership", userId: requesterId }],
                "@odata.nextLink": `https://graph.microsoft.com/v1.0/chats/${encodeURIComponent(chatId)}/members?$skiptoken=next`,
              },
        };
      };
      graph.onRequest = ({ method }) => {
        if (method === "GET" && fixture.nativeRequests.length === stopAfter) {
          if (stopAfter === 1) {
            fixture.revokeTurn();
          } else {
            fixture.revokeClaim();
          }
        }
      };
      const result = await settle(
        fixture.invoke("tool", "removeParticipant", { target: chatId, userId: memberId }),
      );
      const expectedRequests = [
        `GET ${chatPath}/members`,
        `GET ${chatPath}/members?$skiptoken=next`,
        `DELETE ${chatPath}/members/${membershipId}`,
      ];
      expect(
        fixture.nativeRequests.map(
          ({ method, url }) => `${method} ${decodeURIComponent(url.pathname + url.search)}`,
        ),
      ).toEqual(stopAfter ? expectedRequests.slice(0, stopAfter) : expectedRequests);
      expect(result).toMatchObject(
        stopAfter
          ? { error: expect.any(Error) }
          : { value: { removed: { userId: memberId, chatId } } },
      );
    },
  );

  it("isolates one caller's cancellation from a concurrent valid operation", async () => {
    const fixture = await createFixture({ origin: "bundled", self: true });
    const caller = new AbortController();
    const started = createDeferred<void>();
    const finish = createDeferred<void>();
    graph.acquireToken.mockImplementationOnce(async () => {
      started.resolve();
      await finish.promise;
      return token;
    });
    const canceled = settle(
      fixture.invoke(
        "tool",
        "pin",
        { target: chatId, messageId: "canceled-message" },
        caller.signal,
      ),
    );
    await started.promise;
    caller.abort(new Error("Caller canceled"));
    await expect(
      fixture.invoke("tool", "pin", { target: chatId, messageId: "valid-message" }),
    ).resolves.toMatchObject({ pinnedMessageId: "pin-1" });
    finish.resolve();
    expect(await canceled).toMatchObject({ error: expect.any(Error) });
    expect(fixture.requests).toEqual([`POST ${chatPath}/pinnedMessages`]);
    expect(fixture.nativeRequests[0]?.body).toEqual({
      "message@odata.bind": `https://graph.microsoft.com/v1.0/chats/${encodeURIComponent(chatId)}/messages/valid-message`,
    });
    expect(fixture.providerSettlements).toMatchObject([
      { action: "pin", result: { details: { pinnedMessageId: "pin-1" } } },
      { action: "pin", error: expect.any(Error) },
    ]);
  });

  it.each([false, true])(
    "keeps target-authorization Graph lookups current (revoked=%s)",
    async (revoked) => {
      const fixture = await createFixture({ origin: "bundled", botFrameworkTeam: true });
      graph.reply = ({ url }) =>
        url.pathname.endsWith("/channels")
          ? { body: { value: [{ id: currentChannel }, { id: targetChannel }] } }
          : undefined;
      if (revoked) {
        graph.onRequest = fixture.revokeTurn;
      }
      const result = await settle(
        fixture.invoke("tool", "react", { target, messageId, emoji: "like" }),
      );
      expect(fixture.requests).toEqual([
        `GET /v1.0/teams/${teamId}/channels`,
        ...(!revoked
          ? [
              `POST /beta/teams/${teamId}/channels/${targetChannel}/messages/${messageId}/setReaction`,
            ]
          : []),
      ]);
      expect(result).toMatchObject(
        revoked ? { error: expect.any(Error) } : { value: { ok: true, reactionType: "like" } },
      );
    },
  );

  it.each(["pin", "removeParticipant"] as const)(
    "retains the accepted %s provider result after the caller closes",
    async (action) => {
      const fixture = await createFixture({ origin: "bundled", self: true, senderIsOwner: true });
      graph.onRequest = ({ method }) => {
        if (method !== "GET") {
          fixture.revokeClaim();
        }
      };
      graph.reply = ({ method }) =>
        method === "POST"
          ? { status: 201, body: { id: "accepted-pin" } }
          : method === "DELETE"
            ? { status: 204 }
            : undefined;
      await settle(fixture.invoke("tool", action, { target: chatId, messageId, userId: memberId }));
      expect(fixture.requests).toEqual(
        action === "pin"
          ? [`POST ${chatPath}/pinnedMessages`]
          : [`GET ${chatPath}/members`, `DELETE ${chatPath}/members/${membershipId}`],
      );
      expect(fixture.providerSettlements).toMatchObject([
        {
          action,
          result: {
            details:
              action === "pin"
                ? { ok: true, pinnedMessageId: "accepted-pin" }
                : { ok: true, removed: { userId: memberId, chatId } },
          },
        },
      ]);
    },
  );

  it.each([
    ["pin", false],
    ["pin", true],
    ["removeParticipant", false],
    ["removeParticipant", true],
  ] as const)(
    "preserves the %s provider failure after preparation (revoked=%s)",
    async (action, revoked) => {
      const fixture = await createFixture({ origin: "bundled", self: true, senderIsOwner: true });
      graph.onRequest = ({ method }) => {
        if (revoked && method !== "GET") {
          fixture.revokeTurn();
        }
      };
      graph.reply = ({ method }) =>
        method !== "GET"
          ? {
              status: 403,
              body: { error: { code: "Forbidden", message: "Graph fixture refused" } },
            }
          : undefined;
      const result = await settle(
        fixture.invoke("tool", action, { target: chatId, messageId, userId: memberId }),
      );
      expect(fixture.requests).toEqual(
        action === "pin"
          ? [`POST ${chatPath}/pinnedMessages`]
          : [`GET ${chatPath}/members`, `DELETE ${chatPath}/members/${membershipId}`],
      );
      const providerFailure = { message: expect.stringMatching(/403.*Graph fixture refused/s) };
      expect(fixture.providerSettlements).toMatchObject([{ action, error: providerFailure }]);
      expect(result).toMatchObject({ error: revoked ? expect.any(Error) : providerFailure });
    },
  );

  it.each(
    mutationCases.filter(({ action }) =>
      ["addParticipant", "removeParticipant", "renameGroup"].includes(action),
    ),
  )("keeps the owner requirement for $name", async ({ action, params }) => {
    const fixture = await createFixture({ origin: "bundled", self: true });
    await expect(
      fixture.invoke("tool", action, { target: chatId, ...params }),
    ).resolves.toMatchObject({
      error: expect.stringMatching(/owner or operator.admin/),
    });
    expect(fixture.requests).toEqual([]);
    expect(graph.acquireToken).not.toHaveBeenCalled();
  });

  it("rejects invalid participant roles before Graph", async () => {
    const fixture = await createFixture({ origin: "bundled", self: true, senderIsOwner: true });
    await expect(
      fixture.invoke("tool", "addParticipant", {
        target: chatId,
        userId: memberId,
        role: "administrator",
      }),
    ).rejects.toThrow(/role must be/);
    expect(fixture.requests).toEqual([]);
  });

  it("does not let an owner substitute for a trusted requester", async () => {
    const fixture = await createFixture({
      origin: "bundled",
      self: true,
      senderIsOwner: true,
      missingRequester: true,
    });
    await expect(
      fixture.invoke("tool", "addParticipant", { target: chatId, userId: memberId }),
    ).rejects.toThrow(/requester|sender/i);
    expect(fixture.requests).toEqual([]);
  });

  it("rejects an unknown mutation account before Graph", async () => {
    const fixture = await createFixture({ origin: "bundled", self: true });
    await expect(
      fixture.invoke("tool", "pin", { target: chatId, messageId, accountId: "other" }),
    ).rejects.toThrow(/account/i);
    expect(fixture.requests).toEqual([]);
  });

  it("keeps reaction targets inside the configured channel scope", async () => {
    const fixture = await createFixture({ origin: "bundled", narrowTeam: true });
    await expect(
      fixture.invoke("tool", "react", { target: currentTarget, messageId, emoji: "like" }),
    ).rejects.toThrow(/not allowed/i);
    expect(fixture.requests).toEqual([]);
  });

  it.each(["pin", "unpin"] as const)("keeps channel %s unsupported", async (action) => {
    const fixture = await createFixture({ origin: "bundled" });
    await expect(
      fixture.invoke("tool", action, { target, messageId, pinnedMessageId: "pin-1" }),
    ).rejects.toThrow(/not supported for channel messages/);
    expect(fixture.requests).toEqual([]);
  });
});

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
