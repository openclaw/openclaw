import { afterEach, describe, expect, it } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { GatewayCredentialsRequiredError } from "../gateway/call.js";
import { GatewayClientRequestError } from "../gateway/client.js";
import {
  classifyLookupFailure,
  lookupFailedDenialSuffix,
  resolveSessionChannelScope,
  type SessionChannelScope,
} from "./session-visibility-internal.js";
import {
  createAgentToAgentPolicy,
  createSessionVisibilityChecker,
  createSessionVisibilityGuard,
  createSessionVisibilityRowChecker,
  resolveEffectiveSessionToolsVisibility,
  resolveSessionToolsVisibility,
} from "./session-visibility.js";

const defaults = {
  action: "history",
  requesterSessionKey: "agent:main:main",
  visibility: "self",
  a2aPolicy: createAgentToAgentPolicy({}),
} as const;
const denied = (error: string) => ({ allowed: false, status: "forbidden", error });
const historyRestricted =
  "Session history visibility is restricted. Set tools.sessions.visibility=all to allow cross-agent access; use tools.agentToAgent to restrict permitted agent pairs.";
const workAgent = {
  requesterAgentId: "work",
  visibility: "agent",
  defaultAgentId: "main",
} as const;
const grantFor = (expectedSessionId: string) => ({ expectedSessionId });
const { resolveScopedAccess: resolveScoped, resolveScopedAccessAsync: resolveScopedAsync } =
  createSessionVisibilityChecker;
function direct(options: Partial<Parameters<typeof createSessionVisibilityChecker>[0]>) {
  return createSessionVisibilityChecker({ ...defaults, spawnedKeys: null, ...options });
}
function rowChecker(options: Partial<Parameters<typeof createSessionVisibilityRowChecker>[0]>) {
  return createSessionVisibilityRowChecker({ ...defaults, ...options });
}
const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).toReversed()) {
    cleanup();
  }
});
function registerProvider(
  ...args: Parameters<typeof createSessionVisibilityChecker.registerScopedAccessProvider>
) {
  const unregister = createSessionVisibilityChecker.registerScopedAccessProvider(...args);
  cleanups.push(unregister);
  return unregister;
}

describe("scoped session access providers", () => {
  const scopedRequest = {
    action: "history",
    requesterSessionKey: "agent:main:requester",
    targetSessionKey: "agent:main:target",
  } as const;

  it("keeps synchronous checks fresh while the async companion reads current state", async () => {
    let expectedSessionId = "first-incarnation";
    const provider = () => grantFor(expectedSessionId);
    registerProvider(provider, {
      resolveAsync: async () => grantFor(`async-${expectedSessionId}`),
    });
    const params = { ...defaults, ...scopedRequest };
    const checker = direct(params);
    const guard = await createSessionVisibilityGuard(params);
    for (const incarnation of ["first-incarnation", "second-incarnation"]) {
      expectedSessionId = incarnation;
      const grant = { allowed: true, expectedSessionId };
      expect(checker.check(scopedRequest.targetSessionKey)).toEqual(grant);
      expect(guard.check(scopedRequest.targetSessionKey)).toEqual(grant);
      expect(resolveScoped(scopedRequest)).toEqual(grantFor(expectedSessionId));
      await expect(resolveScopedAsync(scopedRequest)).resolves.toEqual(
        grantFor(`async-${incarnation}`),
      );
    }
  });

  it("discards an awaited grant after unregister-and-replace of the same callback", async () => {
    const pending = createDeferred<{ expectedSessionId: string }>();
    const provider = () => grantFor("sync-incarnation");
    const unregister = registerProvider(provider, {
      resolveAsync: () => pending.promise,
    });
    const resolving = resolveScopedAsync(scopedRequest);
    unregister();
    registerProvider(provider, {
      resolveAsync: async () => grantFor("replacement-incarnation"),
    });
    pending.resolve(grantFor("retired-incarnation"));
    await expect(resolving).resolves.toBeUndefined();
    unregister();
    await expect(resolveScopedAsync(scopedRequest)).resolves.toEqual(
      grantFor("replacement-incarnation"),
    );
  });

  it("preserves provider order and skips registrations retired while an earlier provider awaits", async () => {
    const pending = createDeferred<undefined>();
    registerProvider(() => undefined, {
      resolveAsync: () => pending.promise,
    });
    const unregisterSecond = registerProvider(() => grantFor("retired-second"));
    registerProvider(() => grantFor("third"));
    const resolving = resolveScopedAsync(scopedRequest);
    unregisterSecond();
    pending.resolve(undefined);
    await expect(resolving).resolves.toEqual(grantFor("third"));
  });

  it.each([
    ["configured default", "main", "agent", historyRestricted],
    [
      "missing owner",
      undefined,
      "all",
      "Session history denied because target agent ownership is unavailable.",
    ],
  ] as const)("denies unscoped rows with %s", (_name, defaultAgentId, visibility, error) => {
    const checker = direct({
      requesterAgentId: "work",
      requesterSessionKey: "agent:work:main",
      defaultAgentId,
      visibility,
    });
    expect(checker.check("main")).toEqual(denied(error));
  });

  it("accepts a legacy Set spawnedKeys input on the exported checker", () => {
    const checker = direct({
      visibility: "tree",
      spawnedKeys: new Set(["agent:main:subagent:child-1"]),
    });

    expect(checker.check("agent:main:subagent:child-1")).toEqual({ allowed: true });
    expect(checker.check("agent:main:subagent:unrelated")).toEqual(
      denied(
        "Session history visibility is restricted to the current session tree (tools.sessions.visibility=tree).",
      ),
    );
  });

  it("gives the canonical main session agent-wide access under tree visibility", () => {
    const checker = rowChecker({
      requesterSessionKey: "agent:main:work",
      mainSessionKey: "agent:main:work",
      visibility: "tree",
    });

    expect(checker.check({ key: "agent:main:telegram:group:unspawned" })).toEqual({
      allowed: true,
    });
  });

  it("keeps exact and current self aliases available without a configured default", () => {
    const checker = direct({
      requesterAgentId: "work",
      requesterSessionKey: "main",
    });

    expect(checker.check("main")).toEqual({ allowed: true });
    expect(checker.check("current")).toEqual({ allowed: true });
  });

  it.each([
    ["explicit row ownership", "history", "main", historyRestricted],
    [
      "configured default without row metadata",
      "send",
      undefined,
      "Session send visibility is restricted. Configure agents.entries.<id>.tools.agentToAgent.send for explicit send-only destinations, or tools.sessions.visibility=all for shared access. Global agent-to-agent and sandbox limits still apply.",
    ],
  ] as const)("honors %s for bare requester aliases", (_name, action, agentId, error) => {
    const checker = rowChecker({ ...workAgent, action, requesterSessionKey: "main" });
    expect(checker.check({ key: "main", agentId })).toEqual(denied(error));
  });

  it("grants only the exact requester, target, and action supplied by a provider", () => {
    const makeChecker = (action: "history" | "send") =>
      direct({
        action,
        requesterAgentId: "main",
        requesterSessionKey: "agent:main:clickclack:channel:discussion",
        visibility: "tree",
        spawnedKeys: new Set(),
      });
    const history = makeChecker("history");
    const send = makeChecker("send");
    const target = "agent:main:main";

    expect(history.check(target).allowed).toBe(false);
    const unregister = registerProvider((request) =>
      request.action === "history" &&
      request.requesterSessionKey === "agent:main:clickclack:channel:discussion" &&
      request.targetSessionKey === target
        ? grantFor("main-incarnation")
        : undefined,
    );
    expect(history.check(target)).toEqual({
      allowed: true,
      expectedSessionId: "main-incarnation",
    });
    expect(send.check(target).allowed).toBe(false);
    expect(history.check("agent:main:other").allowed).toBe(false);
    unregister();
    expect(history.check(target).allowed).toBe(false);
  });

  it("keeps incognito sessions hidden from scoped and ownership grants", () => {
    const requesterSessionKey = "agent:main:main";
    const targetSessionKey = "agent:main:dashboard:incognito-private";
    const expected = denied(`Session not visible from session tools: ${targetSessionKey}`);
    registerProvider(() => grantFor("incognito-incarnation"));
    const checker = direct({
      requesterSessionKey,
      mainSessionKey: requesterSessionKey,
      visibility: "tree",
      spawnedKeys: new Set([targetSessionKey]),
    });
    const row = rowChecker({
      requesterSessionKey,
      mainSessionKey: requesterSessionKey,
      visibility: "tree",
    });

    expect(checker.check(targetSessionKey)).toEqual(expected);
    expect(row.check({ key: targetSessionKey, spawnedBy: requesterSessionKey })).toEqual(expected);
  });

  it("fails closed when a provider throws", () => {
    registerProvider(() => {
      throw new Error("provider failure");
    });
    const checker = direct({
      action: "status",
      requesterAgentId: "main",
      requesterSessionKey: "agent:main:requester",
    });
    expect(checker.check("agent:main:target").allowed).toBe(false);
  });
});

it("requires both requester and target to match a configured allow entry", () => {
  const policy = createAgentToAgentPolicy({
    tools: { agentToAgent: { enabled: true, allow: ["main"] } },
  });
  expect(policy.isAllowed("main", "ops")).toBe(false);
  expect(policy.isAllowed("ops", "main")).toBe(false);
  expect(policy.isAllowed("main", "main")).toBe(true);
});

it.each([
  [[" "], false],
  [["ops-*"], true],
  [["*"], true],
] as const)("matches only explicit send destinations: %s", (destinations, allowed) => {
  const send = [...destinations];
  const a2aPolicy = createAgentToAgentPolicy({
    agents: { entries: { ReSeArCh: { tools: { agentToAgent: { send } } } } },
  });
  expect(a2aPolicy.isAllowed("research", "ops-west")).toBe(true);
  for (const visibility of ["agent", "all"] as const) {
    const checker = rowChecker({
      action: "send",
      requesterSessionKey: "agent:research:main",
      visibility,
      a2aPolicy,
    });
    expect(checker.check({ key: "agent:ops-west:main" }).allowed).toBe(allowed);
  }
});

describe("classifyLookupFailure", () => {
  const transportError = (code: number) =>
    Object.assign(new Error("gateway transport failed"), {
      name: "GatewayTransportError",
      kind: "closed",
      connectionDetails: {},
      code,
    });
  it.each([
    [
      "retryable request",
      new GatewayClientRequestError({
        code: "UNAVAILABLE",
        message: "transport timeout",
        retryable: true,
      }),
      "transient",
    ],
    ["transport 1013", transportError(1013), "transient"],
    ["transport 1008", transportError(1008), "unknown"],
    [
      "pre-connect auth",
      new GatewayCredentialsRequiredError({
        method: "sessions.list",
        configPath: "/tmp/openclaw.json",
      }),
      "credentials",
    ],
  ] as const)("classifies %s", (_name, error, expected) => {
    expect(classifyLookupFailure(error)).toBe(expected);
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

  it("derives a channel scope only when stored facts match the normalized key peer", () => {
    expect(resolveSessionChannelScope(storedRow())).toEqual(scope);
    expect(
      resolveSessionChannelScope(
        storedRow({
          origin: {
            provider: "slack",
            accountId: "default",
            chatType: "channel",
            to: "C1",
          },
        }),
      ),
    ).toEqual(scope);
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
    const reassignedScope = resolveSessionChannelScope(
      storedRow({
        deliveryContext: { channel: "slack", accountId: "default", to: "channel:C2" },
      }),
    );
    expect(reassignedScope).toEqual({ ...scope, to: "channel:C2" });
    expect(
      createSessionVisibilityRowChecker(params).check({
        key: sibling,
        channelScope: reassignedScope,
      }).allowed,
    ).toBe(false);
  });

  it.each([
    { key: "agent:main:main" },
    { key: "agent:main:slack:direct:U1" },
    { key: "agent:main:discord:channel:C1" },
    { origin: { provider: "discord", accountId: "default", chatType: "channel" } },
    { origin: { provider: "slack", accountId: "other", chatType: "channel" } },
    { origin: { provider: "slack", accountId: "default", chatType: "direct" } },
    {
      origin: {
        provider: "slack",
        accountId: "default",
        chatType: "channel",
        to: "channel:C2",
      },
    },
    { origin: {} },
    { space: undefined },
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
    expect(checker.check({ key: sibling, channelScope: { ...scope, to: "C1" } }).allowed).toBe(
      true,
    );
  });

  it.each(["send", "status"] as const)(
    "keeps same-channel sibling %s outside retrieval authority",
    (action) => {
      const checker = createSessionVisibilityRowChecker({ ...params, action });
      expect(checker.check({ key: requester, channelScope: scope })).toEqual({ allowed: true });
      expect(checker.check({ key: sibling, channelScope: scope })).toEqual({
        allowed: false,
        status: "forbidden",
        error:
          "Channel visibility authorizes cross-session retrieval, not sibling sends or status changes.",
      });
    },
  );

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

  it("denies channel visibility when both scopes omit workspace identity", () => {
    const incompleteScope = { ...scope, space: undefined };
    const checker = createSessionVisibilityRowChecker({
      ...params,
      requesterChannelScope: incompleteScope,
    });
    expect(checker.check({ key: sibling, channelScope: incompleteScope }).allowed).toBe(false);
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
