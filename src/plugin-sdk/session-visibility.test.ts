import { describe, expect, it } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { GatewayCredentialsRequiredError } from "../gateway/call.js";
import { GatewayClientRequestError } from "../gateway/client.js";
import { classifyLookupFailure, lookupFailedDenialSuffix } from "./session-visibility-internal.js";
import {
  createAgentToAgentPolicy,
  createSessionVisibilityChecker,
  createSessionVisibilityGuard,
  createSessionVisibilityRowChecker,
  resolveEffectiveSessionToolsVisibility,
  resolveSessionChannelScope,
  resolveSessionToolsVisibility,
  type SessionChannelScope,
} from "./session-visibility.js";

describe("scoped session access providers", () => {
  const scopedRequest = {
    action: "history",
    requesterSessionKey: "agent:main:requester",
    targetSessionKey: "agent:main:target",
  } as const;

  it("keeps synchronous checks fresh while the async companion reads current state", async () => {
    let expectedSessionId = "first-incarnation";
    const provider = () => ({ expectedSessionId });
    const unregister = createSessionVisibilityChecker.registerScopedAccessProvider(provider, {
      resolveAsync: async () => ({ expectedSessionId: `async-${expectedSessionId}` }),
    });
    try {
      const params = {
        ...scopedRequest,
        visibility: "self" as const,
        a2aPolicy: createAgentToAgentPolicy({}),
      };
      const checker = createSessionVisibilityChecker({ ...params, spawnedKeys: null });
      const guard = await createSessionVisibilityGuard(params);
      for (const incarnation of ["first-incarnation", "second-incarnation"]) {
        expectedSessionId = incarnation;
        expect(checker.check(scopedRequest.targetSessionKey)).toEqual({
          allowed: true,
          expectedSessionId,
        });
        expect(guard.check(scopedRequest.targetSessionKey)).toEqual({
          allowed: true,
          expectedSessionId,
        });
        expect(createSessionVisibilityChecker.resolveScopedAccess(scopedRequest)).toEqual({
          expectedSessionId,
        });
        await expect(
          createSessionVisibilityChecker.resolveScopedAccessAsync(scopedRequest),
        ).resolves.toEqual({
          expectedSessionId: `async-${incarnation}`,
        });
      }
    } finally {
      unregister();
    }
  });

  it("discards an awaited grant after unregister-and-replace of the same callback", async () => {
    const pending = createDeferred<{ expectedSessionId: string }>();
    const provider = () => ({ expectedSessionId: "sync-incarnation" });
    const unregister = createSessionVisibilityChecker.registerScopedAccessProvider(provider, {
      resolveAsync: () => pending.promise,
    });
    let unregisterReplacement: (() => void) | undefined;
    try {
      const resolving = createSessionVisibilityChecker.resolveScopedAccessAsync(scopedRequest);
      unregister();
      unregisterReplacement = createSessionVisibilityChecker.registerScopedAccessProvider(
        provider,
        {
          resolveAsync: async () => ({ expectedSessionId: "replacement-incarnation" }),
        },
      );
      pending.resolve({ expectedSessionId: "retired-incarnation" });
      await expect(resolving).resolves.toBeUndefined();
      unregister();
      await expect(
        createSessionVisibilityChecker.resolveScopedAccessAsync(scopedRequest),
      ).resolves.toEqual({ expectedSessionId: "replacement-incarnation" });
    } finally {
      unregister();
      unregisterReplacement?.();
    }
  });

  it("preserves provider order and skips registrations retired while an earlier provider awaits", async () => {
    const pending = createDeferred<undefined>();
    const unregisterFirst = createSessionVisibilityChecker.registerScopedAccessProvider(
      () => undefined,
      {
        resolveAsync: () => pending.promise,
      },
    );
    const unregisterSecond = createSessionVisibilityChecker.registerScopedAccessProvider(() => ({
      expectedSessionId: "retired-second",
    }));
    const unregisterThird = createSessionVisibilityChecker.registerScopedAccessProvider(() => ({
      expectedSessionId: "third",
    }));
    try {
      const resolving = createSessionVisibilityChecker.resolveScopedAccessAsync(scopedRequest);
      unregisterSecond();
      pending.resolve(undefined);
      await expect(resolving).resolves.toEqual({ expectedSessionId: "third" });
    } finally {
      unregisterFirst();
      unregisterSecond();
      unregisterThird();
    }
  });

  it("does not assign an unscoped default-agent row to a non-default requester", () => {
    const checker = createSessionVisibilityChecker({
      action: "history",
      defaultAgentId: "main",
      requesterAgentId: "work",
      requesterSessionKey: "agent:work:main",
      visibility: "agent",
      a2aPolicy: createAgentToAgentPolicy({}),
      spawnedKeys: null,
    });

    expect(checker.check("main")).toEqual({
      allowed: false,
      status: "forbidden",
      error:
        "Session history visibility is restricted. Set tools.sessions.visibility=all to allow cross-agent access; use tools.agentToAgent to restrict permitted agent pairs.",
    });
  });

  it("fails closed for an unscoped row without configured ownership", () => {
    const checker = createSessionVisibilityChecker({
      action: "history",
      requesterAgentId: "work",
      requesterSessionKey: "agent:work:main",
      visibility: "all",
      a2aPolicy: createAgentToAgentPolicy({}),
      spawnedKeys: null,
    });

    expect(checker.check("main")).toEqual({
      allowed: false,
      status: "forbidden",
      error: "Session history denied because target agent ownership is unavailable.",
    });
  });

  it("accepts a legacy Set spawnedKeys input on the exported checker", () => {
    const checker = createSessionVisibilityChecker({
      action: "history",
      requesterSessionKey: "agent:main:main",
      visibility: "tree",
      a2aPolicy: createAgentToAgentPolicy({}),
      spawnedKeys: new Set(["agent:main:subagent:child-1"]),
    });

    expect(checker.check("agent:main:subagent:child-1")).toEqual({ allowed: true });
    expect(checker.check("agent:main:subagent:unrelated")).toEqual({
      allowed: false,
      status: "forbidden",
      error:
        "Session history visibility is restricted to the current session tree (tools.sessions.visibility=tree).",
    });
  });

  it("gives the canonical main session agent-wide access under tree visibility", () => {
    const checker = createSessionVisibilityRowChecker({
      action: "history",
      requesterSessionKey: "agent:main:work",
      mainSessionKey: "agent:main:work",
      visibility: "tree",
      a2aPolicy: createAgentToAgentPolicy({}),
    });

    expect(checker.check({ key: "agent:main:telegram:group:unspawned" })).toEqual({
      allowed: true,
    });
  });

  it("keeps exact and current self aliases available without a configured default", () => {
    const checker = createSessionVisibilityChecker({
      action: "history",
      requesterAgentId: "work",
      requesterSessionKey: "main",
      visibility: "self",
      a2aPolicy: createAgentToAgentPolicy({}),
      spawnedKeys: null,
    });

    expect(checker.check("main")).toEqual({ allowed: true });
    expect(checker.check("current")).toEqual({ allowed: true });
  });

  it("keeps explicit row ownership authoritative when a bare key matches the requester", () => {
    const checker = createSessionVisibilityRowChecker({
      action: "history",
      defaultAgentId: "main",
      requesterAgentId: "work",
      requesterSessionKey: "main",
      visibility: "agent",
      a2aPolicy: createAgentToAgentPolicy({}),
    });

    expect(checker.check({ key: "main", agentId: "main" })).toEqual({
      allowed: false,
      status: "forbidden",
      error:
        "Session history visibility is restricted. Set tools.sessions.visibility=all to allow cross-agent access; use tools.agentToAgent to restrict permitted agent pairs.",
    });
  });

  it("resolves a bare requester alias through the configured default before row metadata exists", () => {
    const checker = createSessionVisibilityRowChecker({
      action: "send",
      defaultAgentId: "main",
      requesterAgentId: "work",
      requesterSessionKey: "main",
      visibility: "agent",
      a2aPolicy: createAgentToAgentPolicy({}),
    });

    expect(checker.check({ key: "main" })).toEqual({
      allowed: false,
      status: "forbidden",
      error:
        "Session send visibility is restricted. Configure agents.entries.<id>.tools.agentToAgent.send for explicit send-only destinations, or tools.sessions.visibility=all for shared access. Global agent-to-agent and sandbox limits still apply.",
    });
  });

  it("grants only the exact requester, target, and action supplied by a provider", () => {
    const makeChecker = (action: "history" | "send") =>
      createSessionVisibilityChecker({
        action,
        requesterAgentId: "main",
        requesterSessionKey: "agent:main:clickclack:channel:discussion",
        visibility: "tree",
        a2aPolicy: createAgentToAgentPolicy({}),
        spawnedKeys: new Set(),
      });
    const history = makeChecker("history");
    const send = makeChecker("send");
    const target = "agent:main:main";

    expect(history.check(target).allowed).toBe(false);
    const unregister = createSessionVisibilityChecker.registerScopedAccessProvider((request) =>
      request.action === "history" &&
      request.requesterSessionKey === "agent:main:clickclack:channel:discussion" &&
      request.targetSessionKey === target
        ? { expectedSessionId: "main-incarnation" }
        : undefined,
    );
    try {
      expect(history.check(target)).toEqual({
        allowed: true,
        expectedSessionId: "main-incarnation",
      });
      expect(send.check(target).allowed).toBe(false);
      expect(history.check("agent:main:other").allowed).toBe(false);
    } finally {
      unregister();
    }
    expect(history.check(target).allowed).toBe(false);
  });

  it("keeps incognito sessions hidden from scoped and ownership grants", () => {
    const requesterSessionKey = "agent:main:main";
    const targetSessionKey = "agent:main:dashboard:incognito-private";
    const expected = {
      allowed: false,
      status: "forbidden",
      error: `Session not visible from session tools: ${targetSessionKey}`,
    } as const;
    const unregister = createSessionVisibilityChecker.registerScopedAccessProvider(() => ({
      expectedSessionId: "incognito-incarnation",
    }));
    try {
      const direct = createSessionVisibilityChecker({
        action: "history",
        requesterSessionKey,
        mainSessionKey: requesterSessionKey,
        visibility: "tree",
        a2aPolicy: createAgentToAgentPolicy({}),
        spawnedKeys: new Set([targetSessionKey]),
      });
      const row = createSessionVisibilityRowChecker({
        action: "history",
        requesterSessionKey,
        mainSessionKey: requesterSessionKey,
        visibility: "tree",
        a2aPolicy: createAgentToAgentPolicy({}),
      });

      expect(direct.check(targetSessionKey)).toEqual(expected);
      expect(row.check({ key: targetSessionKey, spawnedBy: requesterSessionKey })).toEqual(
        expected,
      );
    } finally {
      unregister();
    }
  });

  it("fails closed when a provider throws", () => {
    const unregister = createSessionVisibilityChecker.registerScopedAccessProvider(() => {
      throw new Error("provider failure");
    });
    try {
      const checker = createSessionVisibilityChecker({
        action: "status",
        requesterAgentId: "main",
        requesterSessionKey: "agent:main:requester",
        visibility: "self",
        a2aPolicy: createAgentToAgentPolicy({}),
        spawnedKeys: null,
      });
      expect(checker.check("agent:main:target").allowed).toBe(false);
    } finally {
      unregister();
    }
  });
});

describe("createAgentToAgentPolicy allow list", () => {
  it("requires both requester and target to match a configured allow entry", () => {
    const policy = createAgentToAgentPolicy({
      tools: { agentToAgent: { enabled: true, allow: ["main"] } },
    });
    expect(policy.isAllowed("main", "ops")).toBe(false);
    expect(policy.isAllowed("ops", "main")).toBe(false);
    expect(policy.isAllowed("main", "main")).toBe(true);
  });
});

describe("directed send matcher", () => {
  it.each([
    { send: [" "], narrow: false, broad: false },
    { send: ["ops-*"], narrow: true, broad: true },
    { send: ["*"], narrow: true, broad: true },
  ])("matches only explicit send destinations: $send", ({ send, narrow, broad }) => {
    const a2aPolicy = createAgentToAgentPolicy({
      agents: { entries: { ReSeArCh: { tools: { agentToAgent: { send } } } } },
    });
    expect(a2aPolicy.isAllowed("research", "ops-west")).toBe(true);
    for (const [visibility, allowed] of [
      ["agent", narrow],
      ["all", broad],
    ] as const) {
      const checker = createSessionVisibilityRowChecker({
        action: "send",
        requesterSessionKey: "agent:research:main",
        visibility,
        a2aPolicy,
      });
      expect(checker.check({ key: "agent:ops-west:main" }).allowed).toBe(allowed);
    }
  });
});

describe("classifyLookupFailure", () => {
  it("classifies a retryable gateway request error as transient", () => {
    const error = new GatewayClientRequestError({
      code: "UNAVAILABLE",
      message: "transport timeout",
      retryable: true,
    });
    expect(classifyLookupFailure(error)).toBe("transient");
  });

  it.each([
    { kind: "closed", code: 1013, expected: "transient" },
    { kind: "closed", code: 1008, expected: "unknown" },
  ] as const)(
    "classifies gateway transport $kind/$code as $expected",
    ({ kind, code, expected }) => {
      const error = Object.assign(new Error("gateway transport failed"), {
        name: "GatewayTransportError",
        kind,
        connectionDetails: {},
        ...(code === undefined ? {} : { code }),
      });
      expect(classifyLookupFailure(error)).toBe(expected);
    },
  );

  it("classifies an explicit pre-connect auth failure as credentials", () => {
    const error = new GatewayCredentialsRequiredError({
      method: "sessions.list",
      configPath: "/tmp/openclaw.json",
    });
    expect(classifyLookupFailure(error)).toBe("credentials");
  });

  it("renders cause-appropriate denial suffixes", () => {
    expect(lookupFailedDenialSuffix("transient")).toMatch(/transient\); retry/i);
    expect(lookupFailedDenialSuffix("credentials")).toMatch(
      /check gateway configuration and credentials/i,
    );
    expect(lookupFailedDenialSuffix("unknown")).toMatch(/inspect OpenClaw logs/i);
    expect(lookupFailedDenialSuffix("unknown")).not.toMatch(/credentials|retry/i);
  });
});

describe("channel-scoped session visibility", () => {
  const requester = "agent:main:slack:channel:C1:thread:100.1";
  const sibling = "agent:main:slack:channel:C1:thread:200.2";
  const scope: SessionChannelScope = {
    provider: "slack",
    accountId: "default",
    to: "channel:C1",
    kind: "channel",
    space: "T1",
  };
  const params = {
    action: "history" as const,
    requesterSessionKey: requester,
    requesterChannelScope: scope,
    visibility: "channel" as const,
    a2aPolicy: createAgentToAgentPolicy({}),
  };
  const storedRow = (overrides: Record<string, unknown> = {}) => ({
    key: sibling,
    origin: { provider: "slack", accountId: "default", chatType: "channel" },
    deliveryContext: {
      channel: "slack",
      accountId: "default",
      to: "channel:C1",
      threadId: "200.2",
    },
    space: "T1",
    ...overrides,
  });

  it("derives a channel scope from stored facts without using the opaque key peer", () => {
    expect(resolveSessionChannelScope(storedRow())).toEqual(scope);
    expect(
      resolveSessionChannelScope(
        storedRow({
          key: "agent:main:matrix:channel:!opaque:thread:room:thread:event",
          origin: { provider: "matrix", accountId: "default", chatType: "channel" },
          deliveryContext: {
            channel: "matrix",
            accountId: "default",
            to: "!opaque:thread:room",
            threadId: "event",
          },
        }),
      ),
    ).toEqual({ ...scope, provider: "matrix", to: "!opaque:thread:room" });
  });

  it.each([
    { key: "agent:main:main" },
    { key: "agent:main:slack:direct:U1" },
    { key: "agent:main:discord:channel:C1" },
    { origin: { provider: "discord", accountId: "default", chatType: "channel" } },
    { origin: { provider: "slack", accountId: "other", chatType: "channel" } },
    { origin: { provider: "slack", accountId: "default", chatType: "direct" } },
    { origin: {} },
    { deliveryContext: { channel: "slack", to: "channel:C1" } },
    { deliveryContext: { channel: "slack", accountId: "default" } },
    { deliveryContext: { accountId: "default", to: "channel:C1" } },
    { deliveryContext: undefined },
  ])("does not invent channel scope from incomplete or inconsistent route %j", (overrides) => {
    expect(resolveSessionChannelScope(storedRow(overrides))).toBeUndefined();
  });

  it("allows same-channel sibling and parent sessions without merging their session keys", () => {
    const checker = createSessionVisibilityRowChecker(params);
    for (const key of [requester, sibling, "agent:main:slack:channel:C1"]) {
      expect(checker.check({ key, channelScope: scope })).toEqual({ allowed: true });
    }
  });

  it.each([
    { channelScope: undefined },
    { key: "agent:main:main", channelScope: scope },
    { key: "agent:main:slack:direct:U1", channelScope: scope },
    { channelScope: { ...scope, provider: "discord" } },
    { channelScope: { ...scope, accountId: "other" } },
    { channelScope: { ...scope, to: "channel:C2" } },
    { channelScope: { ...scope, to: "channel:c1" } },
    { channelScope: { ...scope, space: "T2" } },
    { channelScope: { ...scope, space: undefined } },
    { channelScope: { ...scope, kind: "group" as const } },
    { key: "agent:other:slack:channel:C1:thread:200.2", channelScope: scope },
  ])("denies mismatched or missing scope even with requester ownership %j", (row) => {
    const checker = createSessionVisibilityRowChecker(params);
    expect(checker.check({ key: sibling, spawnedBy: requester, ...row }).allowed).toBe(false);
  });

  it("keeps main and DM callers self-only when they have no verified channel", () => {
    for (const key of ["agent:main:main", "agent:main:slack:direct:U1"]) {
      const checker = createSessionVisibilityRowChecker({
        ...params,
        requesterSessionKey: key,
        mainSessionKey: key,
        requesterChannelScope: undefined,
      });
      expect(checker.check({ key })).toEqual({ allowed: true });
      expect(checker.check({ key: sibling, channelScope: scope }).allowed).toBe(false);
    }
  });

  it("does not let a scoped grant or incognito target bypass the channel ceiling", () => {
    const unregister = createSessionVisibilityChecker.registerScopedAccessProvider(() => ({
      expectedSessionId: "grant",
    }));
    try {
      const checker = createSessionVisibilityChecker({
        ...params,
        spawnedKeys: null,
        channelScopeForSession: () => scope,
      });
      expect(checker.check(sibling)).toEqual({ allowed: true, expectedSessionId: "grant" });
      const restricted = createSessionVisibilityChecker({ ...params, spawnedKeys: null });
      expect(restricted.check(sibling).allowed).toBe(false);
      expect(checker.check("agent:main:dashboard:incognito-test").allowed).toBe(false);
    } finally {
      unregister();
    }
  });

  it("fails closed when a host channel-scope lookup throws", async () => {
    const guard = await createSessionVisibilityGuard({
      ...params,
      channelScopeForSession: () => {
        throw new Error("unavailable");
      },
    });
    expect(guard.check(sibling).allowed).toBe(false);
    expect(guard.check(requester)).toEqual({ allowed: true });
  });

  it("recognizes the explicit setting and intersects the spawned sandbox with self", () => {
    const cfg = { tools: { sessions: { visibility: "channel" as const } } };
    expect(resolveSessionToolsVisibility(cfg)).toBe("channel");
    expect(resolveEffectiveSessionToolsVisibility({ cfg, sandboxed: false })).toBe("channel");
    expect(resolveEffectiveSessionToolsVisibility({ cfg, sandboxed: true })).toBe("self");
    expect(
      resolveEffectiveSessionToolsVisibility({
        cfg: { ...cfg, agents: { defaults: { sandbox: { sessionToolsVisibility: "all" } } } },
        sandboxed: true,
      }),
    ).toBe("channel");
  });
});
