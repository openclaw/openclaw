// Sessions resolution tests cover alias mapping, session-id lookup, and visibility normalization.
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { GatewayClientRequestError } from "../../gateway/client.js";
const callGatewayMock = vi.fn();
vi.mock("../../gateway/call.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../gateway/call.js")>();
  return {
    ...actual,
    callGateway: (opts: unknown) => callGatewayMock(opts),
  };
});
let resolveCurrentSessionClientAlias: typeof import("./sessions-resolution.js").resolveCurrentSessionClientAlias;
let resolveInternalSessionKey: typeof import("./sessions-resolution.js").resolveInternalSessionKey;
let resolveMainSessionAlias: typeof import("./sessions-resolution.js").resolveMainSessionAlias;
let resolveSessionReference: typeof import("./sessions-resolution.js").resolveSessionReference;
let resolveVisibleSessionReference: typeof import("./sessions-resolution.js").resolveVisibleSessionReference;

beforeAll(async () => {
  ({
    resolveCurrentSessionClientAlias,
    resolveInternalSessionKey,
    resolveMainSessionAlias,
    resolveSessionReference,
    resolveVisibleSessionReference,
  } = await import("./sessions-resolution.js"));
});

beforeEach(() => {
  callGatewayMock.mockReset();
});

function expectResolvedSessionReference(
  result: Awaited<ReturnType<typeof resolveSessionReference>>,
  expected: { key: string; displayKey: string; resolvedViaSessionId: boolean },
) {
  expect(result.ok).toBe(true);
  if (!result.ok) {
    throw new Error("Expected resolved session reference");
  }
  expect(result.key).toBe(expected.key);
  expect(result.displayKey).toBe(expected.displayKey);
  expect(result.resolvedViaSessionId).toBe(expected.resolvedViaSessionId);
}

describe("resolveMainSessionAlias", () => {
  it("uses normalized main key and global alias for global scope", () => {
    const cfg = {
      session: { mainKey: " Primary ", scope: "global" },
    } as OpenClawConfig;

    expect(resolveMainSessionAlias(cfg)).toEqual({
      mainKey: "primary",
      alias: "global",
      scope: "global",
    });
  });

  it("falls back to per-sender defaults", () => {
    expect(resolveMainSessionAlias({} as OpenClawConfig)).toEqual({
      mainKey: "main",
      alias: "main",
      scope: "per-sender",
    });
  });
});

describe("session key display/internal mapping", () => {
  it("preserves literal current when no requester key is provided", () => {
    expect(resolveInternalSessionKey({ key: "current", alias: "global" })).toBe("current");
  });

  it("maps interactive client ids to the requester session", () => {
    expect(
      resolveCurrentSessionClientAlias({
        key: "openclaw-tui",
        requesterInternalKey: "agent:main:main",
      }),
    ).toBe("agent:main:main");
    expect(resolveCurrentSessionClientAlias({ key: "openclaw-tui" })).toBeUndefined();
    expect(
      resolveCurrentSessionClientAlias({
        key: "node-host",
        requesterInternalKey: "agent:main:main",
      }),
    ).toBeUndefined();
  });
});

describe("resolved session visibility checks", () => {
  it("rejects incognito targets without consulting Gateway", async () => {
    const sessionKey = "agent:main:dashboard:incognito-private";

    await expect(
      resolveVisibleSessionReference({
        action: "history",
        resolvedSession: {
          ok: true,
          key: sessionKey,
          displayKey: sessionKey,
          resolvedViaSessionId: false,
          requesterOwned: false,
        },
        requesterSessionKey: sessionKey,
        requesterAgentId: "main",
        restrictToSpawned: false,
        visibilitySessionKey: sessionKey,
      }),
    ).resolves.toMatchObject({ ok: false, status: "forbidden" });
    expect(callGatewayMock).not.toHaveBeenCalled();
  });
});

describe("resolveSessionReference", () => {
  it("uses a scoped key's encoded owner before visibility policy", async () => {
    callGatewayMock.mockImplementation(
      async (request: { method?: string; params?: { key?: string; agentId?: string } }) => {
        expect(request.method).toBe("sessions.resolve");
        expect(request.params).toMatchObject({ key: "Agent:ops:main", agentId: "ops" });
        return { key: "agent:ops:main", agentId: "ops" };
      },
    );

    const result = await resolveSessionReference({
      action: "history",
      sessionKey: "Agent:ops:main",
      keyAgentId: "main",
      agentId: "main",
      alias: "main",
      mainKey: "main",
      requesterInternalKey: "agent:main:main",
      restrictToSpawned: false,
    });

    expectResolvedSessionReference(result, {
      key: "agent:ops:main",
      displayKey: "agent:ops:main",
      resolvedViaSessionId: false,
    });
  });

  it("resolves current to the requester before any ownership lookup", async () => {
    const result = await resolveSessionReference({
      action: "status",
      sessionKey: "current",
      keyAgentId: "ops",
      alias: "main",
      mainKey: "main",
      requesterInternalKey: "agent:research:subagent:child",
      restrictToSpawned: false,
    });
    expect(result).toEqual({
      ok: true,
      agentId: "research",
      key: "agent:research:subagent:child",
      displayKey: "agent:research:subagent:child",
      resolvedViaSessionId: false,
      requesterOwned: true,
    });
    expect(callGatewayMock).not.toHaveBeenCalled();
  });

  it("does not reinterpret a failed custom-key lookup as a sessionId miss", async () => {
    callGatewayMock.mockRejectedValueOnce(
      new GatewayClientRequestError({
        code: "UNAVAILABLE",
        message: "gateway unavailable",
        retryable: true,
      }),
    );

    await expect(
      resolveSessionReference({
        action: "send",
        sessionKey: "custom-selector",
        alias: "main",
        mainKey: "main",
        requesterInternalKey: "agent:main:main",
        restrictToSpawned: true,
      }),
    ).resolves.toEqual({
      ok: false,
      status: "forbidden",
      error:
        "Session send denied because spawned-session ownership lookup failed (transient); retry once, then ask the operator to inspect OpenClaw logs.",
    });
    expect(callGatewayMock).toHaveBeenCalledTimes(1);
  });

  it("treats the TUI client label as the requester session", async () => {
    const result = await resolveSessionReference({
      action: "history",
      sessionKey: "openclaw-tui",
      alias: "main",
      mainKey: "main",
      requesterInternalKey: "agent:main:main",
      restrictToSpawned: false,
    });
    expectResolvedSessionReference(result, {
      key: "agent:main:main",
      displayKey: "agent:main:main",
      resolvedViaSessionId: false,
    });
    expect(callGatewayMock).not.toHaveBeenCalled();
  });

  it("preserves the main alias without probing configured-main bootstrap", async () => {
    const result = await resolveSessionReference({
      action: "history",
      sessionKey: "main",
      alias: "main",
      mainKey: "main",
      requesterInternalKey: "agent:main:dashboard:requester",
      restrictToSpawned: false,
    });

    expectResolvedSessionReference(result, {
      key: "main",
      displayKey: "main",
      resolvedViaSessionId: false,
    });
    expect(callGatewayMock).not.toHaveBeenCalled();
  });

  it("canonicalizes an existing explicit session key", async () => {
    callGatewayMock.mockResolvedValueOnce({ key: "agent:ops:main" });

    const resolvedSession = await resolveSessionReference({
      action: "send",
      sessionKey: "agent:OPS:main",
      alias: "main",
      mainKey: "main",
      requesterInternalKey: "agent:main:main",
      restrictToSpawned: false,
    });
    if (!resolvedSession.ok) {
      throw new Error("Expected session reference");
    }
    const result = await resolveVisibleSessionReference({
      action: "send",
      resolvedSession,
      requesterSessionKey: "agent:main:main",
      requesterAgentId: "main",
      restrictToSpawned: false,
      visibilitySessionKey: "agent:OPS:main",
    });

    expect(result).toEqual({
      ok: true,
      agentId: "ops",
      key: "agent:ops:main",
      displayKey: "agent:ops:main",
      requesterOwned: false,
    });
  });

  it("rejects an explicit key that canonicalizes to an incognito session", async () => {
    callGatewayMock.mockResolvedValueOnce({ key: "agent:ops:dashboard:incognito-private" });

    const resolvedSession = await resolveSessionReference({
      action: "history",
      sessionKey: "agent:OPS:dashboard:private",
      alias: "main",
      mainKey: "main",
      requesterInternalKey: "agent:main:main",
      restrictToSpawned: false,
    });
    if (!resolvedSession.ok) {
      throw new Error("Expected session reference");
    }
    const result = await resolveVisibleSessionReference({
      action: "history",
      resolvedSession,
      requesterSessionKey: "agent:main:main",
      requesterAgentId: "main",
      restrictToSpawned: false,
      visibilitySessionKey: "agent:OPS:dashboard:private",
    });

    expect(result).toEqual({
      ok: false,
      status: "forbidden",
      error: "Session not visible from session tools: agent:OPS:dashboard:private",
      displayKey: "agent:ops:dashboard:incognito-private",
    });
  });

  it("propagates explicit-key gateway failures", async () => {
    callGatewayMock.mockRejectedValueOnce(new Error("gateway unavailable"));

    const resolvedSession = await resolveSessionReference({
      action: "send",
      sessionKey: "agent:main:worker",
      alias: "main",
      mainKey: "main",
      requesterInternalKey: "agent:main:main",
      restrictToSpawned: false,
    });
    if (!resolvedSession.ok) {
      throw new Error("Expected session reference");
    }
    const result = await resolveVisibleSessionReference({
      action: "send",
      resolvedSession,
      requesterSessionKey: "agent:main:main",
      requesterAgentId: "main",
      restrictToSpawned: false,
      visibilitySessionKey: "agent:main:worker",
    });

    expect(result).toEqual({
      ok: false,
      status: "error",
      error: "gateway unavailable",
      displayKey: "agent:main:worker",
    });
  });

  it("reports an allowed missing explicit key for deliberate bootstrap", async () => {
    callGatewayMock.mockResolvedValueOnce({});

    const resolvedSession = await resolveSessionReference({
      action: "send",
      sessionKey: "agent:main:main",
      alias: "main",
      mainKey: "main",
      requesterInternalKey: "agent:main:dashboard:requester",
      restrictToSpawned: false,
    });
    if (!resolvedSession.ok) {
      throw new Error("Expected session reference");
    }
    const result = await resolveVisibleSessionReference({
      action: "send",
      resolvedSession,
      requesterSessionKey: "agent:main:dashboard:requester",
      requesterAgentId: "main",
      restrictToSpawned: false,
      visibilitySessionKey: "agent:main:main",
      allowMissingKey: true,
    });

    expect(result).toEqual({
      ok: true,
      agentId: "main",
      key: "agent:main:main",
      displayKey: "agent:main:main",
      missing: true,
      requesterOwned: false,
    });
    expect(callGatewayMock).toHaveBeenCalledWith({
      method: "sessions.resolve",
      params: {
        key: "agent:main:main",
        agentId: "main",
        spawnedBy: undefined,
        allowMissing: true,
      },
    });
  });
});
