import { afterEach, describe, expect, it } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { GatewayCredentialsRequiredError } from "../gateway/call.js";
import { GatewayClientRequestError } from "../gateway/client.js";
import { classifyLookupFailure, lookupFailedDenialSuffix } from "./session-visibility-internal.js";
import {
  createAgentToAgentPolicy,
  createSessionVisibilityChecker,
  createSessionVisibilityGuard,
  createSessionVisibilityRowChecker,
} from "./session-visibility.js";

const defaults = {
  action: "history",
  requesterSessionKey: "agent:main:main",
  visibility: "self",
  a2aPolicy: createAgentToAgentPolicy({}),
} as const;
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
    const provider = () => ({ expectedSessionId });
    registerProvider(provider, {
      resolveAsync: async () => ({ expectedSessionId: `async-${expectedSessionId}` }),
    });
    const params = {
      ...scopedRequest,
      ...defaults,
      requesterSessionKey: scopedRequest.requesterSessionKey,
    };
    const checker = direct(params);
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
  });

  it("discards an awaited grant after unregister-and-replace of the same callback", async () => {
    const pending = createDeferred<{ expectedSessionId: string }>();
    const provider = () => ({ expectedSessionId: "sync-incarnation" });
    const unregister = registerProvider(provider, {
      resolveAsync: () => pending.promise,
    });
    const resolving = createSessionVisibilityChecker.resolveScopedAccessAsync(scopedRequest);
    unregister();
    registerProvider(provider, {
      resolveAsync: async () => ({ expectedSessionId: "replacement-incarnation" }),
    });
    pending.resolve({ expectedSessionId: "retired-incarnation" });
    await expect(resolving).resolves.toBeUndefined();
    unregister();
    await expect(
      createSessionVisibilityChecker.resolveScopedAccessAsync(scopedRequest),
    ).resolves.toEqual({ expectedSessionId: "replacement-incarnation" });
  });

  it("preserves provider order and skips registrations retired while an earlier provider awaits", async () => {
    const pending = createDeferred<undefined>();
    registerProvider(() => undefined, {
      resolveAsync: () => pending.promise,
    });
    const unregisterSecond = registerProvider(() => ({
      expectedSessionId: "retired-second",
    }));
    registerProvider(() => ({
      expectedSessionId: "third",
    }));
    const resolving = createSessionVisibilityChecker.resolveScopedAccessAsync(scopedRequest);
    unregisterSecond();
    pending.resolve(undefined);
    await expect(resolving).resolves.toEqual({ expectedSessionId: "third" });
  });

  it("does not assign an unscoped default-agent row to a non-default requester", () => {
    const checker = direct({
      defaultAgentId: "main",
      requesterAgentId: "work",
      requesterSessionKey: "agent:work:main",
      visibility: "agent",
    });

    expect(checker.check("main")).toEqual({
      allowed: false,
      status: "forbidden",
      error:
        "Session history visibility is restricted. Set tools.sessions.visibility=all to allow cross-agent access; use tools.agentToAgent to restrict permitted agent pairs.",
    });
  });

  it("fails closed for an unscoped row without configured ownership", () => {
    const checker = direct({
      requesterAgentId: "work",
      requesterSessionKey: "agent:work:main",
      visibility: "all",
    });

    expect(checker.check("main")).toEqual({
      allowed: false,
      status: "forbidden",
      error: "Session history denied because target agent ownership is unavailable.",
    });
  });

  it("accepts a legacy Set spawnedKeys input on the exported checker", () => {
    const checker = direct({
      visibility: "tree",
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

  it("keeps explicit row ownership authoritative when a bare key matches the requester", () => {
    const checker = rowChecker({
      defaultAgentId: "main",
      requesterAgentId: "work",
      requesterSessionKey: "main",
      visibility: "agent",
    });

    expect(checker.check({ key: "main", agentId: "main" })).toEqual({
      allowed: false,
      status: "forbidden",
      error:
        "Session history visibility is restricted. Set tools.sessions.visibility=all to allow cross-agent access; use tools.agentToAgent to restrict permitted agent pairs.",
    });
  });

  it("resolves a bare requester alias through the configured default before row metadata exists", () => {
    const checker = rowChecker({
      action: "send",
      defaultAgentId: "main",
      requesterAgentId: "work",
      requesterSessionKey: "main",
      visibility: "agent",
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
        ? { expectedSessionId: "main-incarnation" }
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
    const expected = {
      allowed: false,
      status: "forbidden",
      error: `Session not visible from session tools: ${targetSessionKey}`,
    } as const;
    registerProvider(() => ({
      expectedSessionId: "incognito-incarnation",
    }));
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
      const checker = rowChecker({
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
