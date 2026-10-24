import { createServer } from "node:http";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { msteamsPlugin } from "../extensions/msteams/api.js";
import { createMessageTool } from "../src/agents/tools/message-tool-execution.js";
import type { ChannelMessageActionName } from "../src/channels/plugins/message-action-names.js";
import type { ChannelMessageActionContext } from "../src/channels/plugins/types.core.js";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../src/config/config.js";
import type { OpenClawConfig } from "../src/config/types.js";
import { sendHandlers } from "../src/gateway/server-methods/send.js";
import type { GatewayRequestContext } from "../src/gateway/server-methods/types.js";
import { getPluginInstance } from "../src/plugins/plugin-instance-scope.js";
import { createPluginRegistry } from "../src/plugins/registry.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../src/plugins/runtime.js";
import type { PluginRuntime } from "../src/plugins/runtime/types.js";
import { createPluginRecord } from "../src/plugins/status.test-fixtures.js";
import { createMessageReadAuthority } from "./message-read-authority.test-support.js";

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
};
type Route = "tool" | "gateway";
type Origin = "bundled" | "global";
type ActionParams = Record<string, unknown>;
type ActionCase = [action: ChannelMessageActionName, params: ActionParams, requests: string[]];
type FixtureOptions = {
  origin?: Origin;
  self?: boolean;
  narrowTeam?: boolean;
  senderIsOwner?: boolean;
  botFrameworkTeam?: boolean;
  missingRequester?: boolean;
};
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

async function createFixture(options: FixtureOptions = {}) {
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
    trustedOfficialInstall: origin === "global",
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
  const run = createMessageReadAuthority({
    runId: `teams-read-${++sequence}`,
    sessionKey,
    // Capability minting normalizes an empty requester to the same absent identity.
    requesterSenderId: options.missingRequester ? "" : requesterId,
    toolContext,
    gatewayContext: "resolved",
  });
  const context = {
    dedupe: new Map(),
    getRuntimeConfig: () => cfg,
    validateAgentRuntimeApprovalAuthority: run.validate,
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
        body = { value: [{ id: membershipId, userId: memberId }] };
      } else if (url.pathname.includes("/channels/") && !url.pathname.includes("/messages")) {
        body = {
          id: decodeURIComponent(url.pathname.split("/").at(-1)!),
          membershipType: graph.membershipType,
        };
      } else if (url.pathname.endsWith("/pinnedMessages")) {
        body = request.method === "POST" ? { id: "pin-1" } : { value: [{ id: "pin-1", message }] };
      }
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(body));
    });
  });
  cleanups.push(async () => {
    run.dispose();
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
  const tool = run.wrap(
    createMessageTool({
      ...run.options,
      senderIsOwner: options.senderIsOwner,
      config: cfg,
    }),
  );

  return {
    requests,
    nativeRequests,
    providerSettlements,
    tool,
    revokeTurn: run.revokeTurn,
    revokeClaim: run.releaseClaim,
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
        client: run.client,
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

function settle<T>(pending: Promise<T>) {
  return pending.then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
}

function holdPreparation(stage = "token") {
  const started = createDeferred<void>();
  const finish = createDeferred<void>();
  const hold = async () => {
    started.resolve();
    await finish.promise;
    return token;
  };
  if (stage === "sdk") {
    graph.prepareSdk.mockImplementation(async () => {
      await hold();
    });
  } else if (stage === "dns") {
    graph.beforeLookup = async () => {
      await hold();
    };
  } else {
    graph.acquireToken.mockImplementation(hold);
  }
  return { started: started.promise, finish: finish.resolve };
}

const ownedChat = { origin: "bundled", self: true, senderIsOwner: true } as const;
const localChat = { origin: "bundled", self: true } as const;

describe("Teams Graph mutation currentness", () => {
  const chatPath = `/v1.0/chats/${chatId}`;
  const mutationCases: ActionCase[] = [
    ["pin", { messageId }, [`POST ${chatPath}/pinnedMessages`]],
    ["unpin", { pinnedMessageId: "pin-1" }, [`DELETE ${chatPath}/pinnedMessages/pin-1`]],
    [
      "react",
      { messageId, emoji: "like" },
      [`POST /beta/chats/${chatId}/messages/${messageId}/setReaction`],
    ],
    [
      "react",
      { messageId, emoji: "like", remove: true },
      [`POST /beta/chats/${chatId}/messages/${messageId}/unsetReaction`],
    ],
    ["addParticipant", { userId: memberId }, [`POST ${chatPath}/members`]],
    [
      "removeParticipant",
      { userId: memberId },
      [`GET ${chatPath}/members`, `DELETE ${chatPath}/members/${membershipId}`],
    ],
    ["renameGroup", { name: "Renamed chat" }, [`PATCH ${chatPath}`]],
  ];

  it.each([
    ...mutationCases.map((testCase) => ({ testCase, revoked: true, stage: "token" })),
    { testCase: mutationCases[0]!, revoked: false, stage: "token" },
    ...["sdk", "dns"].flatMap((stage) =>
      [false, true].map((revoked) => ({ testCase: mutationCases[0]!, revoked, stage })),
    ),
  ])(
    "checks the admitted $testCase after $stage preparation (revoked=$revoked)",
    async ({ testCase: [action, params, requests], revoked, stage }) => {
      const fixture = await createFixture({
        origin: "bundled",
        self: true,
        senderIsOwner: stage === "token" ? true : undefined,
      });
      const preparation = holdPreparation(stage);
      const result = settle(fixture.invoke("tool", action, { target: chatId, ...params }));
      await preparation.started;
      if (revoked) {
        fixture.revokeTurn();
      }
      preparation.finish();
      const settled = await result;
      const details = { ok: true, action, pinnedMessageId: "pin-1" };

      // The outer tool can reject after Graph has written; observe the native request itself.
      expect(fixture.requests).toEqual(revoked ? [] : requests);
      expect(settled).toMatchObject(revoked ? { error: expect.any(Error) } : { value: details });
      expect(fixture.providerSettlements).toMatchObject([
        revoked ? { action, error: expect.any(Error) } : { action, result: { details } },
      ]);
      if (stage === "sdk" && revoked) {
        expect(graph.acquireToken).not.toHaveBeenCalled();
      }
    },
  );

  it.each([
    [307, false],
    [307, true],
    [308, false],
  ] as const)(
    "checks a same-origin %s redirect before replay (revoked=%s)",
    async (status, revoked) => {
      const fixture = await createFixture(localChat);
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
      const fixture = await createFixture(ownedChat);
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
    const fixture = await createFixture(localChat);
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

  it.each([
    ["pin", "accepted", true],
    ["removeParticipant", "accepted", true],
    ["pin", "failure", false],
    ["pin", "failure", true],
    ["removeParticipant", "failure", false],
    ["removeParticipant", "failure", true],
  ] as const)(
    "preserves the %s provider %s after preparation (revoked=%s)",
    async (action, outcome, revoked) => {
      const fixture = await createFixture(ownedChat);
      graph.onRequest = ({ method }) => {
        if (revoked && method !== "GET") {
          if (outcome === "accepted") {
            fixture.revokeClaim();
          } else {
            fixture.revokeTurn();
          }
        }
      };
      graph.reply = ({ method }) => {
        if (outcome === "failure") {
          return method !== "GET"
            ? {
                status: 403,
                body: { error: { code: "Forbidden", message: "Graph fixture refused" } },
              }
            : undefined;
        }
        return method === "POST"
          ? { status: 201, body: { id: "accepted-pin" } }
          : method === "DELETE"
            ? { status: 204 }
            : undefined;
      };
      const result = await settle(
        fixture.invoke("tool", action, { target: chatId, messageId, userId: memberId }),
      );
      expect(fixture.requests).toEqual(
        action === "pin"
          ? [`POST ${chatPath}/pinnedMessages`]
          : [`GET ${chatPath}/members`, `DELETE ${chatPath}/members/${membershipId}`],
      );
      if (outcome === "failure") {
        const providerFailure = { message: expect.stringMatching(/403.*Graph fixture refused/s) };
        expect(fixture.providerSettlements).toMatchObject([{ action, error: providerFailure }]);
        expect(result).toMatchObject({ error: revoked ? expect.any(Error) : providerFailure });
      } else {
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
      }
    },
  );

  it.each<[ChannelMessageActionName, FixtureOptions, ActionParams, RegExp]>([
    [
      "addParticipant",
      { self: true, senderIsOwner: true, missingRequester: true },
      { target: chatId, userId: memberId },
      /requester|sender/i,
    ],
    ["pin", { self: true }, { target: chatId, messageId, accountId: "other" }, /account/i],
    [
      "react",
      { narrowTeam: true },
      { target: currentTarget, messageId, emoji: "like" },
      /not allowed/i,
    ],
    [
      "pin",
      {},
      { target, messageId, pinnedMessageId: "pin-1" },
      /not supported for channel messages/,
    ],
  ])("rejects %s with %j before Graph", async (action, options, params, error) => {
    const fixture = await createFixture({ origin: "bundled", ...options });
    await expect(fixture.invoke("tool", action, params)).rejects.toThrow(error);
    expect(fixture.requests).toEqual([]);
  });
});

// Registry provenance is an explicit fixture; package installation is proved separately.
describe.each([
  ["tool", "bundled"],
  ["gateway", "global"],
] as const)("Teams %s reads with a %s registration", (route, origin) => {
  it("reads a message with admitted authority", async () => {
    const fixture = await createFixture({ origin });
    const messagePath = `/v1.0/teams/${teamId}/channels/${targetChannel}/messages/${messageId}`;
    await expect(fixture.invoke(route, "read", { target, messageId })).resolves.toMatchObject({
      ok: true,
      channel: "msteams",
      action: "read",
      message: { id: messageId, text: message.body.content },
    });
    expect(fixture.requests).toEqual([`GET ${messagePath}`]);
  });

  it.each(["turn-token", "plugin-token", "run-response", "plugin-entry"] as const)(
    "fences a read when its lifetime closes at %s",
    async (stage) => {
      const local = stage === "plugin-entry";
      const fixture = await createFixture({ origin, self: local });
      const heldToken = stage === "turn-token" || stage === "plugin-token";
      const preparation = heldToken ? holdPreparation() : undefined;
      if (local) {
        graph.afterEntry = fixture.retirePlugin;
      } else if (!heldToken) {
        graph.onRequest = fixture.revokeClaim;
      }
      const result = fixture.invoke(
        route,
        local ? "member-info" : "read",
        local ? { userId: requesterId } : { target, messageId },
      );
      const rejected = expect(result).rejects.toThrow(/no longer active|authority/i);
      if (preparation) {
        await preparation.started;
        if (stage === "turn-token") {
          fixture.revokeTurn();
        } else {
          fixture.retirePlugin();
        }
        preparation.finish();
      }
      await rejected;
      if (stage === "run-response") {
        expect(fixture.requests).toHaveLength(1);
      } else {
        expect(fixture.requests).toEqual([]);
      }
      if (local) {
        expect(graph.acquireToken).not.toHaveBeenCalled();
      }
    },
  );
});

describe.each(["tool", "gateway"] as const)("Teams %s policy controls", (route) => {
  it.each(["account", "membership"])("enforces %s read policy", async (boundary) => {
    const fixture = await createFixture();
    if (boundary === "account") {
      await expect(
        fixture.invoke(route, "read", { target, messageId, accountId: "other" }),
      ).rejects.toThrow(/account/i);
      expect(fixture.requests).toEqual([]);
    } else {
      graph.membershipType = "private";
      await expect(fixture.invoke(route, "member-info", { userId: memberId })).rejects.toThrow(
        /standard channel/,
      );
      expect(fixture.requests).toHaveLength(1);
      expect(fixture.requests[0]).not.toContain("/members");
    }
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
