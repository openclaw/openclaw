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
let resolution: typeof import("./sessions-resolution.js");
beforeAll(async () => {
  resolution = await import("./sessions-resolution.js");
});

beforeEach(() => {
  callGatewayMock.mockReset();
});

function expectResolvedSessionReference(
  result: Awaited<ReturnType<typeof resolution.resolveSessionReference>>,
  key: string,
) {
  expect(result).toMatchObject({ ok: true, key, displayKey: key, resolvedViaSessionId: false });
}

function resolveReference(
  params: Pick<Parameters<typeof resolution.resolveSessionReference>[0], "sessionKey"> &
    Partial<Parameters<typeof resolution.resolveSessionReference>[0]>,
) {
  return resolution.resolveSessionReference({
    action: "history",
    alias: "main",
    mainKey: "main",
    requesterInternalKey: "agent:main:main",
    restrictToSpawned: false,
    ...params,
  });
}

async function resolveVisible(
  sessionKey: string,
  action: "send" | "history" = "send",
  requesterSessionKey = "agent:main:main",
  allowMissingKey = false,
) {
  const resolvedSession = await resolveReference({
    action,
    sessionKey,
    requesterInternalKey: requesterSessionKey,
  });
  if (!resolvedSession.ok) {
    throw new Error("Expected session reference");
  }
  return resolution.resolveVisibleSessionReference({
    action,
    resolvedSession,
    requesterSessionKey,
    requesterAgentId: "main",
    restrictToSpawned: false,
    visibilitySessionKey: sessionKey,
    allowMissingKey,
  });
}

describe("resolveMainSessionAlias", () => {
  it.each([
    [{ session: { mainKey: " Primary ", scope: "global" } }, "primary", "global", "global"],
    [{}, "main", "main", "per-sender"],
  ] satisfies Array<[OpenClawConfig, string, string, string]>)(
    "normalizes %j",
    (cfg, mainKey, alias, scope) => {
      expect(resolution.resolveMainSessionAlias(cfg)).toEqual({ mainKey, alias, scope });
    },
  );
});

describe("session key display/internal mapping", () => {
  it("preserves literal current when no requester key is provided", () => {
    expect(resolution.resolveInternalSessionKey({ key: "current", alias: "global" })).toBe(
      "current",
    );
  });

  it("maps interactive client ids to the requester session", () => {
    expect(
      resolution.resolveCurrentSessionClientAlias({
        key: "openclaw-tui",
        requesterInternalKey: "agent:main:main",
      }),
    ).toBe("agent:main:main");
    expect(resolution.resolveCurrentSessionClientAlias({ key: "openclaw-tui" })).toBeUndefined();
    expect(
      resolution.resolveCurrentSessionClientAlias({
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
      resolution.resolveVisibleSessionReference({
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

    const result = await resolveReference({
      sessionKey: "Agent:ops:main",
      keyAgentId: "main",
      agentId: "main",
    });

    expectResolvedSessionReference(result, "agent:ops:main");
  });

  it("resolves current to the requester before any ownership lookup", async () => {
    const result = await resolveReference({
      action: "status",
      sessionKey: "current",
      keyAgentId: "ops",
      requesterInternalKey: "agent:research:subagent:child",
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
      resolveReference({
        action: "send",
        sessionKey: "custom-selector",
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

  it.each([
    ["openclaw-tui", "agent:main:main", "agent:main:main"],
    ["main", "agent:main:dashboard:requester", "main"],
  ])("resolves %s without a Gateway probe", async (sessionKey, requesterInternalKey, expected) => {
    expectResolvedSessionReference(
      await resolveReference({ sessionKey, requesterInternalKey }),
      expected,
    );
    expect(callGatewayMock).not.toHaveBeenCalled();
  });

  it("canonicalizes an existing explicit session key", async () => {
    callGatewayMock.mockResolvedValueOnce({ key: "agent:ops:main" });

    const result = await resolveVisible("agent:OPS:main");

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

    const result = await resolveVisible("agent:OPS:dashboard:private", "history");

    expect(result).toEqual({
      ok: false,
      status: "forbidden",
      error: "Session not visible from session tools: agent:OPS:dashboard:private",
      displayKey: "agent:ops:dashboard:incognito-private",
    });
  });

  it("propagates explicit-key gateway failures", async () => {
    callGatewayMock.mockRejectedValueOnce(new Error("gateway unavailable"));

    const result = await resolveVisible("agent:main:worker");

    expect(result).toEqual({
      ok: false,
      status: "error",
      error: "gateway unavailable",
      displayKey: "agent:main:worker",
    });
  });

  it("reports an allowed missing explicit key for deliberate bootstrap", async () => {
    callGatewayMock.mockResolvedValueOnce({});

    const result = await resolveVisible(
      "agent:main:main",
      "send",
      "agent:main:dashboard:requester",
      true,
    );

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
