import { createServer } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { msteamsPlugin } from "../extensions/msteams/api.js";
import { dispatchChannelMessageAction } from "../src/channels/plugins/message-action-dispatch.js";
import type { ChannelThreadingToolContext } from "../src/channels/plugins/types.public.js";
import { formatMessageCliText } from "../src/commands/message-format.js";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../src/config/config.js";
import type { OpenClawConfig } from "../src/config/types.js";
import { sendHandlers } from "../src/gateway/server-methods/send.js";
import type { GatewayRequestContext } from "../src/gateway/server-methods/types.js";
import { getPluginInstance } from "../src/plugins/plugin-instance-scope.js";
import { createTestPluginRegistry } from "../src/plugins/registry-runtime.test-helpers.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../src/plugins/runtime.js";
import { createPluginRecord } from "../src/plugins/status.test-fixtures.js";
import {
  closeHttpServer,
  listenLoopback,
  respondJson,
} from "./helpers/gateway-integration-fixtures.js";
import { createMessageReadAuthority } from "./message-read-authority.test-support.js";

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
const messageSender = { user: { id: memberId, displayName: "Member" } };
const messageCreatedAt = "2026-10-13T12:00:00Z";
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
  searchMatches = 1,
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
  const owner = createTestPluginRegistry();
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
  const authority = createMessageReadAuthority({
    runId: `teams-target-${++sequence}`,
    sessionKey,
    requesterSenderId: requesterId,
    toolContext: toolContext ?? {},
    gatewayContext: "resolved",
  });
  const context = {
    dedupe: new Map(),
    getRuntimeConfig: () => cfg,
    validateAgentRuntimeApprovalAuthority: authority.validate,
  } as GatewayRequestContext;
  const requests: GraphRequest[] = [];
  const controller = new AbortController();
  const pending = new Set<Promise<unknown>>();
  const graphMessage = (destination: Destination, id = destination.messageId) => ({
    id,
    body: { content: destination.text, contentType: "text" },
    from: messageSender,
    createdDateTime: messageCreatedAt,
  });
  const routes = new Map<string, unknown>();
  for (const destination of [current, other]) {
    const teamPath = `/v1.0/teams/${destination.teamId}`;
    const channelPath = `${teamPath}/channels/${destination.channelId}`;
    routes.set(`${teamPath}/members`, {
      value: [
        {
          userId: memberId,
          displayName: "Member",
          email: "member@example.test",
          roles: destination.roles,
        },
      ],
    });
    routes.set(channelPath, { id: destination.channelId, membershipType: "standard" });
    routes.set(`${channelPath}/messages`, {
      value: Array.from({ length: searchMatches }, (_, index) =>
        graphMessage(
          destination,
          index ? `${destination.messageId}-${index}` : destination.messageId,
        ),
      ),
    });
    routes.set(`${channelPath}/messages/${destination.messageId}`, graphMessage(destination));
  }
  const server = createServer((request, response) => {
    const path = decodeURIComponent(new URL(request.url ?? "/", "http://fixture.invalid").pathname);
    requests.push({ method: request.method, path, authorization: request.headers.authorization });
    request.resume();
    respondJson(
      response,
      routes.get(path) ?? { error: { message: "Unexpected Graph fixture route" } },
      routes.has(path) ? 200 : 404,
    );
  });
  cleanups.push(async () => {
    controller.abort(new Error("Teams fixture closed"));
    authority.dispose();
    server.closeAllConnections();
    await Promise.allSettled(pending);
    await closeHttpServer(server);
    await getPluginInstance(record)?.dispose();
    graph.endpoint = undefined;
  });
  graph.endpoint = { origin: await listenLoopback(server), signal: controller.signal };
  const tool = authority.createTool(cfg);
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
    expectNoGraphRequests() {
      expect(requests).toEqual([]);
      expect(graph.acquireToken).not.toHaveBeenCalled();
    },
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
          client: authority.client,
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
    invokeAdapter(action: Action | "read", params: Record<string, unknown>) {
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

function inputFor(action: Action | "read"): Record<string, unknown> {
  return action === "search"
    ? { query: "planning", limit: 1 }
    : action === "read"
      ? { messageId: other.messageId }
      : { userId: memberId };
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

describe("Teams registered adapter output", () => {
  it("renders Graph read and search payloads", async () => {
    const fixture = await createFixture("none");
    const message = {
      id: other.messageId,
      text: other.text,
      from: messageSender,
      createdAt: messageCreatedAt,
    };
    const format = (action: "read" | "search", payload: unknown) =>
      formatMessageCliText({
        kind: "action",
        channel: "msteams",
        action,
        payload,
        dryRun: false,
        handledBy: "plugin",
      }).join("\n");
    for (const action of ["read", "search"] as const) {
      const payload = await fixture.invokeAdapter(action, { to: otherTarget });
      expect(payload).toEqual({
        ok: true,
        channel: "msteams",
        action,
        ...(action === "read" ? { message } : { messages: [message], truncated: false }),
      });
      const output = format(action, payload);
      for (const value of [other.text, other.messageId, "Member", messageCreatedAt]) {
        expect.soft(output).toContain(value);
      }
    }
  });

  it.each([
    { limit: 30, count: 30, truncated: false },
    { limit: 60, count: 50, truncated: true },
  ])(
    "searches a selected channel with limit $limit and no guild",
    async ({ limit, count, truncated }) => {
      const fixture = await createFixture("none", "bundled", limit);
      const payload = await fixture.invokeAdapter("search", { channelId: otherTarget, limit });
      expect(payload).toMatchObject({
        ok: true,
        channel: "msteams",
        action: "search",
        truncated,
        messages: expect.any(Array),
      });
      expect(payload).toHaveProperty("messages.length", count);
      expectGraphRequests(fixture.requests, "search", other);
    },
  );

  it("rejects a malformed limit in the registered search adapter", async () => {
    const fixture = await createFixture("none");
    await expect(
      fixture.invokeAdapter("search", { channelId: otherTarget, limit: "abc" }),
    ).rejects.toThrow("limit must be a positive integer");
    fixture.expectNoGraphRequests();
  });
});

describe.each([
  ["tool", "search", "bundled"],
  ["gateway", "member-info", "global"],
] as const)("Teams %s %s aliases (%s)", (route, action, origin) => {
  it.each([
    { name: "bare", channelId: current.channelId },
    { name: "thread-qualified", channelId: `conversation:${current.channelId};messageid=123` },
    { name: "Graph", channelId: currentTarget },
  ])("reads the current channel with a $name target", async ({ channelId }) => {
    const fixture = await createFixture("channel", origin);
    const result = await fixture.invoke(route, action, { channelId });
    expectReadResult(result, action, current);
    expectGraphRequests(fixture.requests, action, current);
  });
});

describe.each(["tool", "gateway"] as const)("Teams %s read target selection", (route) => {
  describe.each(["search", "member-info"] as const)("%s", (action) => {
    it.each([
      { context: "channel", params: {}, destination: current },
      { context: "channel", params: { channelId: otherTarget }, destination: other },
      { context: "none", params: { channelId: otherTarget }, destination: other },
    ] as const)("reads $params in $context context", async ({ context, params, destination }) => {
      const fixture = await createFixture(context);
      expectReadResult(await fixture.invoke(route, action, params), action, destination);
      expectGraphRequests(fixture.requests, action, destination);
    });

    it("preserves the missing-target error when no current context exists", async () => {
      const fixture = await createFixture("none");
      await expect(fixture.invoke(route, action)).resolves.toEqual({
        error: `${action === "search" ? "Search" : "member-info"} requires a target (to).`,
      });
      fixture.expectNoGraphRequests();
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
        fixture.expectNoGraphRequests();
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
    fixture.expectNoGraphRequests();
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
      ] as const) {
        const before = fixture.requests.length;
        const result = await fixture.invokeAdapter(action, params);
        expectReadResult(result, action, destination);
        expectGraphRequests(fixture.requests.slice(before), action, destination);
      }
    });
  },
);
