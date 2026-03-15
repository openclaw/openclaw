import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";

const callGatewayMock = vi.fn();
vi.mock("../../gateway/call.js", () => ({
  callGateway: (opts: unknown) => callGatewayMock(opts),
}));

import {
  createAgentToAgentPolicy,
  createSessionVisibilityGuard,
  precheckSessionLookupAccess,
  resolveEffectiveSessionToolsVisibility,
  resolveSandboxSessionToolsVisibility,
  resolveSandboxedSessionToolContext,
  resolveSessionToolsVisibility,
} from "./sessions-access.js";

function mockSpawnedSessions(sessionKeys: string[]) {
  callGatewayMock.mockImplementation(async (opts: unknown) => {
    const request = opts as { method?: string; params?: Record<string, unknown> };
    if (request.method === "sessions.list") {
      return {
        sessions: sessionKeys.map((key) => ({ key })),
      };
    }
    return {};
  });
}

beforeEach(() => {
  callGatewayMock.mockReset();
});

describe("resolveSessionToolsVisibility", () => {
  it("defaults to tree when unset or invalid", () => {
    expect(resolveSessionToolsVisibility({} as unknown as OpenClawConfig)).toBe("tree");
    expect(
      resolveSessionToolsVisibility({
        tools: { sessions: { visibility: "invalid" } },
      } as unknown as OpenClawConfig),
    ).toBe("tree");
  });

  it("accepts known visibility values case-insensitively", () => {
    expect(
      resolveSessionToolsVisibility({
        tools: { sessions: { visibility: "ALL" } },
      } as unknown as OpenClawConfig),
    ).toBe("all");
  });
});

describe("resolveEffectiveSessionToolsVisibility", () => {
  it("clamps to tree in sandbox when sandbox visibility is spawned", () => {
    const cfg = {
      tools: { sessions: { visibility: "all" } },
      agents: { defaults: { sandbox: { sessionToolsVisibility: "spawned" } } },
    } as unknown as OpenClawConfig;
    expect(resolveEffectiveSessionToolsVisibility({ cfg, sandboxed: true })).toBe("tree");
  });

  it("preserves visibility when sandbox clamp is all", () => {
    const cfg = {
      tools: { sessions: { visibility: "all" } },
      agents: { defaults: { sandbox: { sessionToolsVisibility: "all" } } },
    } as unknown as OpenClawConfig;
    expect(resolveEffectiveSessionToolsVisibility({ cfg, sandboxed: true })).toBe("all");
  });
});

describe("sandbox session-tools context", () => {
  it("defaults sandbox visibility clamp to spawned", () => {
    expect(resolveSandboxSessionToolsVisibility({} as unknown as OpenClawConfig)).toBe("spawned");
  });

  it("restricts non-subagent sandboxed sessions to spawned visibility", () => {
    const cfg = {
      tools: { sessions: { visibility: "all" } },
      agents: { defaults: { sandbox: { sessionToolsVisibility: "spawned" } } },
    } as unknown as OpenClawConfig;
    const context = resolveSandboxedSessionToolContext({
      cfg,
      agentSessionKey: "agent:main:main",
      sandboxed: true,
    });

    expect(context.restrictToSpawned).toBe(true);
    expect(context.requesterInternalKey).toBe("agent:main:main");
    expect(context.effectiveRequesterKey).toBe("agent:main:main");
  });

  it("does not restrict subagent sessions in sandboxed mode", () => {
    const cfg = {
      tools: { sessions: { visibility: "all" } },
      agents: { defaults: { sandbox: { sessionToolsVisibility: "spawned" } } },
    } as unknown as OpenClawConfig;
    const context = resolveSandboxedSessionToolContext({
      cfg,
      agentSessionKey: "agent:main:subagent:abc",
      sandboxed: true,
    });

    expect(context.restrictToSpawned).toBe(false);
    expect(context.requesterInternalKey).toBe("agent:main:subagent:abc");
  });
});

describe("createAgentToAgentPolicy", () => {
  it("denies cross-agent access when disabled", () => {
    const policy = createAgentToAgentPolicy({} as unknown as OpenClawConfig);
    expect(policy.enabled).toBe(false);
    expect(policy.isAllowed("main", "main")).toBe(true);
    expect(policy.isAllowed("main", "ops")).toBe(false);
  });

  it("honors allow patterns when enabled", () => {
    const policy = createAgentToAgentPolicy({
      tools: {
        agentToAgent: {
          enabled: true,
          allow: ["ops-*", "main"],
        },
      },
    } as unknown as OpenClawConfig);

    expect(policy.isAllowed("ops-a", "ops-b")).toBe(true);
    expect(policy.isAllowed("main", "ops-a")).toBe(true);
    expect(policy.isAllowed("guest", "ops-a")).toBe(false);
  });
});

describe("precheckSessionLookupAccess", () => {
  it("adds a spawnedBy constraint for tree-only owned ACP cross-agent lookups", () => {
    const access = precheckSessionLookupAccess({
      action: "send",
      requesterSessionKey: "agent:main:main",
      targetAgentId: "ops",
      visibility: "tree",
      ownedAcpEnabled: true,
      a2aPolicy: createAgentToAgentPolicy({} as unknown as OpenClawConfig),
    });

    expect(access).toEqual({
      allowed: true,
      spawnedByConstraint: "agent:main:main",
    });
  });

  it("keeps tree-only cross-agent lookups blocked when owned ACP visibility is disabled", () => {
    const access = precheckSessionLookupAccess({
      action: "send",
      requesterSessionKey: "agent:main:main",
      targetAgentId: "ops",
      visibility: "tree",
      ownedAcpEnabled: false,
      a2aPolicy: createAgentToAgentPolicy({} as unknown as OpenClawConfig),
    });

    expect(access).toEqual({
      allowed: false,
      status: "forbidden",
      error:
        "Session send visibility is restricted. Set tools.sessions.visibility=all to allow cross-agent access.",
    });
  });
});

describe("createSessionVisibilityGuard", () => {
  it("blocks cross-agent send when agent-to-agent is disabled", async () => {
    const guard = await createSessionVisibilityGuard({
      action: "send",
      requesterSessionKey: "agent:main:main",
      visibility: "all",
      a2aPolicy: createAgentToAgentPolicy({} as unknown as OpenClawConfig),
      ownedAcpEnabled: false,
    });

    expect(guard.check("agent:ops:main")).toEqual({
      allowed: false,
      status: "forbidden",
      error:
        "Agent-to-agent messaging is disabled. Set tools.agentToAgent.enabled=true to allow cross-agent sends.",
    });
  });

  it("enforces self visibility for same-agent sessions", async () => {
    const guard = await createSessionVisibilityGuard({
      action: "history",
      requesterSessionKey: "agent:main:main",
      visibility: "self",
      a2aPolicy: createAgentToAgentPolicy({} as unknown as OpenClawConfig),
      ownedAcpEnabled: false,
    });

    expect(guard.check("agent:main:main")).toEqual({ allowed: true });
    expect(guard.check("agent:main:telegram:group:1")).toEqual({
      allowed: false,
      status: "forbidden",
      error:
        "Session history visibility is restricted to the current session (tools.sessions.visibility=self).",
    });
  });

  it("allows creator-owned ACP sessions across agents when tree visibility enables owned ACP", async () => {
    mockSpawnedSessions(["agent:ops:acp:owned"]);

    const guard = await createSessionVisibilityGuard({
      action: "history",
      requesterSessionKey: "agent:main:main",
      visibility: "tree",
      a2aPolicy: createAgentToAgentPolicy({} as unknown as OpenClawConfig),
      ownedAcpEnabled: true,
    });

    expect(guard.check("agent:ops:acp:owned")).toEqual({ allowed: true });
  });

  it("keeps unrelated ACP sessions hidden even when owned ACP visibility is enabled", async () => {
    mockSpawnedSessions(["agent:ops:acp:owned"]);

    const guard = await createSessionVisibilityGuard({
      action: "history",
      requesterSessionKey: "agent:main:main",
      visibility: "tree",
      a2aPolicy: createAgentToAgentPolicy({} as unknown as OpenClawConfig),
      ownedAcpEnabled: true,
    });

    expect(guard.check("agent:ops:acp:other")).toEqual({
      allowed: false,
      status: "forbidden",
      error:
        "Session history visibility is restricted. Set tools.sessions.visibility=all to allow cross-agent access.",
    });
  });

  it.each(["self", "agent"] as const)(
    "does not extend %s visibility with owned ACP exceptions",
    async (visibility) => {
      mockSpawnedSessions(["agent:ops:acp:owned"]);

      const guard = await createSessionVisibilityGuard({
        action: "send",
        requesterSessionKey: "agent:main:main",
        visibility,
        a2aPolicy: createAgentToAgentPolicy({} as unknown as OpenClawConfig),
        ownedAcpEnabled: true,
      });

      expect(guard.check("agent:ops:acp:owned")).toEqual({
        allowed: false,
        status: "forbidden",
        error:
          "Session send visibility is restricted. Set tools.sessions.visibility=all to allow cross-agent access.",
      });
    },
  );

  it("keeps all visibility behavior unchanged even when owned ACP visibility is enabled", async () => {
    mockSpawnedSessions(["agent:ops:acp:owned"]);

    const guard = await createSessionVisibilityGuard({
      action: "send",
      requesterSessionKey: "agent:main:main",
      visibility: "all",
      a2aPolicy: createAgentToAgentPolicy({} as unknown as OpenClawConfig),
      ownedAcpEnabled: true,
    });

    expect(guard.check("agent:ops:acp:owned")).toEqual({
      allowed: false,
      status: "forbidden",
      error:
        "Agent-to-agent messaging is disabled. Set tools.agentToAgent.enabled=true to allow cross-agent sends.",
    });
  });
});
