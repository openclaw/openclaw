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

  it.each(["unregister", "replace", "unregister-and-replace"] as const)(
    "discards an awaited grant after %s of the same callback",
    async (change) => {
      const pending = createDeferred<{ expectedSessionId: string }>();
      const provider = () => ({ expectedSessionId: "sync-incarnation" });
      const unregister = createSessionVisibilityChecker.registerScopedAccessProvider(provider, {
        resolveAsync: () => pending.promise,
      });
      let unregisterReplacement: (() => void) | undefined;
      try {
        const resolving = createSessionVisibilityChecker.resolveScopedAccessAsync(scopedRequest);
        if (change !== "replace") {
          unregister();
        }
        if (change !== "unregister") {
          unregisterReplacement = createSessionVisibilityChecker.registerScopedAccessProvider(
            provider,
            {
              resolveAsync: async () => ({ expectedSessionId: "replacement-incarnation" }),
            },
          );
        }
        pending.resolve({ expectedSessionId: "retired-incarnation" });
        await expect(resolving).resolves.toBeUndefined();
        unregister();
        await expect(
          createSessionVisibilityChecker.resolveScopedAccessAsync(scopedRequest),
        ).resolves.toEqual(
          change === "unregister" ? undefined : { expectedSessionId: "replacement-incarnation" },
        );
      } finally {
        unregister();
        unregisterReplacement?.();
      }
    },
  );

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

  it("keeps the main exception inside tree same-agent scope", () => {
    const makeChecker = (visibility: "self" | "tree") =>
      createSessionVisibilityRowChecker({
        action: "history",
        requesterSessionKey: "agent:main:main",
        mainSessionKey: "agent:main:main",
        visibility,
        a2aPolicy: createAgentToAgentPolicy({}),
      });

    expect(makeChecker("self").check({ key: "agent:main:telegram:group:room" }).allowed).toBe(
      false,
    );
    expect(makeChecker("tree").check({ key: "agent:other:main" }).allowed).toBe(false);
  });

  it("keeps non-main tree callers scoped to their spawn subtree", () => {
    const requesterSessionKey = "agent:main:telegram:group:requester";
    const checker = createSessionVisibilityRowChecker({
      action: "history",
      requesterSessionKey,
      mainSessionKey: "agent:main:main",
      visibility: "tree",
      a2aPolicy: createAgentToAgentPolicy({}),
    });

    expect(checker.check({ key: "agent:main:main" }).allowed).toBe(false);
    expect(checker.check({ key: "agent:main:telegram:group:sibling" }).allowed).toBe(false);
    expect(
      checker.check({ key: "agent:main:subagent:child", spawnedBy: requesterSessionKey }),
    ).toEqual({ allowed: true });
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
        "Session send visibility is restricted. Set tools.sessions.visibility=all to allow cross-agent access; use tools.agentToAgent to restrict permitted agent pairs.",
    });
  });

  it("keeps the current alias requester-owned when a configured default exists", () => {
    const checker = createSessionVisibilityRowChecker({
      action: "history",
      defaultAgentId: "main",
      requesterAgentId: "work",
      requesterSessionKey: "agent:work:main",
      visibility: "self",
      a2aPolicy: createAgentToAgentPolicy({}),
    });

    expect(checker.check({ key: "current" })).toEqual({ allowed: true });
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
  it.each([
    { name: "omitted", agentToAgent: {} },
    { name: "empty", agentToAgent: { allow: [] } },
  ])(
    "allows every agent pair by default with an $name allow list unless explicitly disabled",
    ({ agentToAgent }) => {
      const enabled = createAgentToAgentPolicy({
        tools: { agentToAgent },
      });
      expect(enabled.enabled).toBe(true);
      expect(enabled.matchesAllow("ops")).toBe(true);
      expect(enabled.isAllowed("main", "ops")).toBe(true);

      const disabled = createAgentToAgentPolicy({
        tools: { agentToAgent: { ...agentToAgent, enabled: false } },
      });
      expect(disabled.enabled).toBe(false);
      expect(disabled.isAllowed("main", "ops")).toBe(false);
    },
  );

  it("requires both requester and target to match a configured allow entry", () => {
    const policy = createAgentToAgentPolicy({
      tools: { agentToAgent: { enabled: true, allow: ["main"] } },
    });
    expect(policy.isAllowed("main", "ops")).toBe(false);
    expect(policy.isAllowed("ops", "main")).toBe(false);
    expect(policy.isAllowed("main", "main")).toBe(true);
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
    { kind: "timeout", code: undefined, expected: "transient" },
    { kind: "closed", code: 1006, expected: "transient" },
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

  it("keeps unknown and non-retryable request failures generic", () => {
    const requestError = new GatewayClientRequestError({
      code: "INTERNAL_ERROR",
      message: "failed to decode session row",
      retryable: false,
    });
    expect(classifyLookupFailure(requestError)).toBe("unknown");
    expect(classifyLookupFailure(new Error("something else"))).toBe("unknown");
    expect(classifyLookupFailure(null)).toBe("unknown");
    expect(classifyLookupFailure(undefined)).toBe("unknown");
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
