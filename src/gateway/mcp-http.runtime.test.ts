import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { AuthorizationInvocationContext } from "../plugins/authorization-policy.types.js";
import { McpLoopbackToolCache, resolveMcpLoopbackScopedTools } from "./mcp-http.runtime.js";

const resolveGatewayScopedTools = vi.hoisted(() => vi.fn());

vi.mock("./tool-resolution.js", () => ({
  resolveGatewayScopedTools,
}));

function scopedToolFixture(names: string[]) {
  return {
    agentId: "main",
    tools: names.map((name) => ({ name, description: `${name} tool` })),
  };
}

function scopeParams(overrides: Record<string, unknown> = {}) {
  return {
    cfg: {} as OpenClawConfig,
    sessionKey: "agent:main:recall",
    messageProvider: undefined,
    currentChannelId: undefined,
    currentThreadTs: undefined,
    currentMessageId: undefined,
    currentInboundAudio: undefined,
    accountId: undefined,
    inboundEventKind: undefined,
    sourceReplyDeliveryMode: undefined,
    senderIsOwner: undefined,
    ...overrides,
  } as Parameters<typeof resolveMcpLoopbackScopedTools>[0];
}

beforeEach(() => {
  resolveGatewayScopedTools.mockReset();
  resolveGatewayScopedTools.mockReturnValue(
    scopedToolFixture(["memory_search", "memory_get", "message", "cron"]),
  );
});

describe("resolveMcpLoopbackScopedTools", () => {
  it("forwards authorization into gateway tool resolution", () => {
    const authorization: AuthorizationInvocationContext = {
      principal: {
        kind: "sender",
        provider: "discord",
        senderId: "maintainer-1",
        roleIds: ["maintainers"],
      },
      sessionKey: "agent:main:recall",
      runId: "run-1",
      trigger: "user",
    };

    resolveMcpLoopbackScopedTools(
      scopeParams({ authorization, requesterIdentitySource: "authority" }),
    );

    expect(resolveGatewayScopedTools).toHaveBeenCalledWith(
      expect.objectContaining({ authorization, requesterIdentitySource: "authority" }),
    );
  });

  it("keeps the full session scope without a grant allowlist", () => {
    const scoped = resolveMcpLoopbackScopedTools(scopeParams());
    expect(scoped.tools.map((tool) => (tool as { name: string }).name)).toEqual([
      "memory_search",
      "memory_get",
      "message",
      "cron",
    ]);
  });

  it("hard-filters the surface to the grant allowlist", () => {
    const scoped = resolveMcpLoopbackScopedTools(
      scopeParams({ toolsAllow: ["memory_search", "memory_get"] }),
    );
    expect(scoped.tools.map((tool) => (tool as { name: string }).name)).toEqual([
      "memory_search",
      "memory_get",
    ]);
  });

  it("fails closed on an empty grant allowlist", () => {
    const scoped = resolveMcpLoopbackScopedTools(scopeParams({ toolsAllow: [] }));
    expect(scoped.tools).toEqual([]);
  });
});

describe("McpLoopbackToolCache", () => {
  const senderAuthorization = (params: {
    aliases?: { name?: string; username?: string; e164?: string };
    roleIds?: string[];
  }): AuthorizationInvocationContext => ({
    principal: {
      kind: "sender",
      provider: "discord",
      accountId: "molty",
      senderId: "maintainer-1",
      aliases: params.aliases,
      senderIsOwner: false,
      isAuthorizedSender: true,
      roleIds: params.roleIds,
    },
    sessionKey: "agent:main:recall",
    sessionId: "session-1",
    runId: "run-1",
    conversationId: "discord:maintenance",
    trigger: "user",
  });

  it.each([
    {
      label: "name",
      first: { name: "Ada Lovelace" },
      second: { name: "Grace Hopper" },
    },
    {
      label: "username",
      first: { username: "ada" },
      second: { username: "grace" },
    },
    {
      label: "e164",
      first: { e164: "+15550000001" },
      second: { e164: "+15550000002" },
    },
  ])("splits cache rows when authoritative sender $label changes", ({ first, second }) => {
    const cache = new McpLoopbackToolCache();
    const cfg = {} as OpenClawConfig;
    resolveGatewayScopedTools
      .mockReturnValueOnce(scopedToolFixture(["first_alias_tool"]))
      .mockReturnValue(scopedToolFixture(["second_alias_tool"]));
    const base = scopeParams({
      cfg,
      authorization: senderAuthorization({ aliases: first }),
      requesterIdentitySource: "authority",
    });

    const firstResult = cache.resolve(base);
    const secondResult = cache.resolve({
      ...base,
      authorization: senderAuthorization({ aliases: second }),
    });
    const repeatedSecondResult = cache.resolve({
      ...base,
      authorization: senderAuthorization({ aliases: second }),
    });

    expect(firstResult.tools.map((tool) => (tool as { name: string }).name)).toEqual([
      "first_alias_tool",
    ]);
    expect(secondResult.tools.map((tool) => (tool as { name: string }).name)).toEqual([
      "second_alias_tool",
    ]);
    expect(repeatedSecondResult).toBe(secondResult);
    expect(resolveGatewayScopedTools).toHaveBeenCalledTimes(2);
  });

  it("ignores conflicting legacy aliases when authoritative identity is unchanged", () => {
    const cache = new McpLoopbackToolCache();
    const cfg = {} as OpenClawConfig;
    const authorization = senderAuthorization({
      aliases: {
        name: "Canonical Name",
        username: "canonical-user",
        e164: "+15550000001",
      },
      roleIds: ["maintainers"],
    });
    const base = scopeParams({
      cfg,
      authorization,
      requesterIdentitySource: "authority",
      channelContext: { sender: { id: "forged-a" } },
      senderName: "Forged A",
      senderUsername: "forged-a",
      senderE164: "+15559999991",
      senderIsOwner: true,
    });

    const firstResult = cache.resolve(base);
    const secondResult = cache.resolve({
      ...base,
      channelContext: { sender: { id: "forged-b" } },
      senderName: "Forged B",
      senderUsername: "forged-b",
      senderE164: "+15559999992",
      senderIsOwner: false,
    });

    expect(secondResult).toBe(firstResult);
    expect(resolveGatewayScopedTools).toHaveBeenCalledTimes(1);
  });

  it("keys authoritative principal kind and role identity", () => {
    const cache = new McpLoopbackToolCache();
    const cfg = {} as OpenClawConfig;
    const base = scopeParams({
      cfg,
      authorization: senderAuthorization({ roleIds: ["maintainers", "reviewers"] }),
      requesterIdentitySource: "authority",
    });

    cache.resolve(base);
    cache.resolve({
      ...base,
      authorization: senderAuthorization({ roleIds: ["reviewers", "maintainers"] }),
    });
    cache.resolve({ ...base, authorization: senderAuthorization({ roleIds: ["guests"] }) });
    cache.resolve({
      ...base,
      authorization: {
        principal: { kind: "operator", scopes: ["operator.write"], isOwner: false },
        sessionKey: "agent:main:recall",
        sessionId: "session-1",
        runId: "run-1",
        trigger: "gateway",
      },
    });

    expect(resolveGatewayScopedTools).toHaveBeenCalledTimes(3);
  });

  it("does not share cache rows across different grant allowlists", () => {
    const cache = new McpLoopbackToolCache();
    const cfg = {} as OpenClawConfig;

    const unrestricted = cache.resolve(scopeParams({ cfg }));
    const restricted = cache.resolve(scopeParams({ cfg, toolsAllow: ["memory_search"] }));
    const denied = cache.resolve(scopeParams({ cfg, toolsAllow: [] }));

    expect(unrestricted.tools).toHaveLength(4);
    expect(restricted.tools).toHaveLength(1);
    expect(denied.tools).toHaveLength(0);
    expect(resolveGatewayScopedTools).toHaveBeenCalledTimes(3);

    // Same allowlist reuses the cached row.
    cache.resolve(scopeParams({ cfg, toolsAllow: ["memory_search"] }));
    expect(resolveGatewayScopedTools).toHaveBeenCalledTimes(3);
  });
});
