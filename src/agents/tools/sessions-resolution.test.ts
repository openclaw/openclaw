import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";

const callGatewayMock = vi.fn();
const logWarnMock = vi.fn();

vi.mock("../../gateway/call.js", () => ({
  callGateway: (opts: unknown) => callGatewayMock(opts),
}));

vi.mock("../../logger.js", () => ({
  logWarn: (message: string) => logWarnMock(message),
}));

import {
  isResolvedSessionVisibleToRequester,
  looksLikeSessionId,
  looksLikeSessionKey,
  resolveDisplaySessionKey,
  resolveInternalSessionKey,
  resolveMainSessionAlias,
  shouldVerifyRequesterSpawnedSessionVisibility,
  shouldResolveSessionIdInput,
} from "./sessions-resolution.js";

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

  it("uses session.mainKey over any legacy routing sessions key", () => {
    const cfg = {
      session: { mainKey: "  work ", scope: "per-sender" },
      routing: { sessions: { mainKey: "legacy-main" } },
    } as OpenClawConfig;

    expect(resolveMainSessionAlias(cfg)).toEqual({
      mainKey: "work",
      alias: "work",
      scope: "per-sender",
    });
  });
});

describe("session key display/internal mapping", () => {
  it("maps alias and main key to display main", () => {
    expect(resolveDisplaySessionKey({ key: "global", alias: "global", mainKey: "main" })).toBe(
      "main",
    );
    expect(resolveDisplaySessionKey({ key: "main", alias: "global", mainKey: "main" })).toBe(
      "main",
    );
    expect(
      resolveDisplaySessionKey({ key: "agent:ops:main", alias: "global", mainKey: "main" }),
    ).toBe("agent:ops:main");
  });

  it("maps input main to alias for internal routing", () => {
    expect(resolveInternalSessionKey({ key: "main", alias: "global", mainKey: "main" })).toBe(
      "global",
    );
    expect(
      resolveInternalSessionKey({ key: "agent:ops:main", alias: "global", mainKey: "main" }),
    ).toBe("agent:ops:main");
  });
});

describe("session reference shape detection", () => {
  it("detects session ids", () => {
    expect(looksLikeSessionId("d4f5a5a1-9f75-42cf-83a6-8d170e6a1538")).toBe(true);
    expect(looksLikeSessionId("not-a-uuid")).toBe(false);
  });

  it("detects canonical session key families", () => {
    expect(looksLikeSessionKey("main")).toBe(true);
    expect(looksLikeSessionKey("agent:main:main")).toBe(true);
    expect(looksLikeSessionKey("cron:daily-report")).toBe(true);
    expect(looksLikeSessionKey("node:macbook")).toBe(true);
    expect(looksLikeSessionKey("telegram:group:123")).toBe(true);
    expect(looksLikeSessionKey("random-slug")).toBe(false);
  });

  it("treats non-keys as session-id candidates", () => {
    expect(shouldResolveSessionIdInput("agent:main:main")).toBe(false);
    expect(shouldResolveSessionIdInput("d4f5a5a1-9f75-42cf-83a6-8d170e6a1538")).toBe(true);
    expect(shouldResolveSessionIdInput("random-slug")).toBe(true);
  });
});

describe("resolved session visibility checks", () => {
  beforeEach(() => {
    callGatewayMock.mockReset();
    logWarnMock.mockReset();
  });

  it("requires spawned-session verification only for sandboxed key-based cross-session access", () => {
    expect(
      shouldVerifyRequesterSpawnedSessionVisibility({
        requesterSessionKey: "agent:main:main",
        targetSessionKey: "agent:main:worker",
        restrictToSpawned: true,
        resolvedViaSessionId: false,
      }),
    ).toBe(true);
    expect(
      shouldVerifyRequesterSpawnedSessionVisibility({
        requesterSessionKey: "agent:main:main",
        targetSessionKey: "agent:main:worker",
        restrictToSpawned: false,
        resolvedViaSessionId: false,
      }),
    ).toBe(false);
    expect(
      shouldVerifyRequesterSpawnedSessionVisibility({
        requesterSessionKey: "agent:main:main",
        targetSessionKey: "agent:main:worker",
        restrictToSpawned: true,
        resolvedViaSessionId: true,
      }),
    ).toBe(false);
    expect(
      shouldVerifyRequesterSpawnedSessionVisibility({
        requesterSessionKey: "agent:main:main",
        targetSessionKey: "agent:main:main",
        restrictToSpawned: true,
        resolvedViaSessionId: false,
      }),
    ).toBe(false);
  });

  it("returns true immediately when spawned-session verification is not required", async () => {
    await expect(
      isResolvedSessionVisibleToRequester({
        requesterSessionKey: "agent:main:main",
        targetSessionKey: "agent:main:main",
        restrictToSpawned: true,
        resolvedViaSessionId: false,
      }),
    ).resolves.toBe(true);
    await expect(
      isResolvedSessionVisibleToRequester({
        requesterSessionKey: "agent:main:main",
        targetSessionKey: "agent:main:other",
        restrictToSpawned: false,
        resolvedViaSessionId: false,
      }),
    ).resolves.toBe(true);
    expect(callGatewayMock).not.toHaveBeenCalled();
  });

  it("retries sessions.list and recovers from transient failure", async () => {
    callGatewayMock
      .mockRejectedValueOnce(new Error("temporary sessions.list outage"))
      .mockResolvedValueOnce({ sessions: [{ key: "agent:main:subagent:child" }] });

    await expect(
      isResolvedSessionVisibleToRequester({
        requesterSessionKey: "agent:main:main",
        targetSessionKey: "agent:main:subagent:child",
        restrictToSpawned: true,
        resolvedViaSessionId: false,
      }),
    ).resolves.toBe(true);

    expect(callGatewayMock).toHaveBeenCalledTimes(2);
    expect(logWarnMock).not.toHaveBeenCalled();
  });

  it("takes fail-open path on persistent sessions.list failure and emits observability", async () => {
    callGatewayMock.mockRejectedValue(new Error("sessions.list failed hard"));

    await expect(
      isResolvedSessionVisibleToRequester({
        requesterSessionKey: "agent:main:main",
        targetSessionKey: "agent:main:not-child",
        restrictToSpawned: true,
        resolvedViaSessionId: false,
      }),
    ).resolves.toBe(true);

    expect(callGatewayMock).toHaveBeenCalledTimes(3);
    expect(logWarnMock).toHaveBeenCalledTimes(1);
    expect(logWarnMock.mock.calls[0]?.[0]).toContain("reason=sessions_list_throw");
    expect(logWarnMock.mock.calls[0]?.[0]).toContain("requester=agent:main:main");
  });

  it("takes fail-open path on unexpected sessions.list shape and emits observability", async () => {
    callGatewayMock.mockResolvedValue({ sessions: { nope: true } });

    await expect(
      isResolvedSessionVisibleToRequester({
        requesterSessionKey: "agent:main:main",
        targetSessionKey: "agent:main:not-child",
        restrictToSpawned: true,
        resolvedViaSessionId: false,
      }),
    ).resolves.toBe(true);

    expect(callGatewayMock).toHaveBeenCalledTimes(1);
    expect(logWarnMock).toHaveBeenCalledTimes(1);
    expect(logWarnMock.mock.calls[0]?.[0]).toContain("reason=sessions_list_unexpected_shape");
    expect(logWarnMock.mock.calls[0]?.[0]).toContain("requester=agent:main:main");
  });

  it("keeps happy path behavior when sessions.list response is valid", async () => {
    callGatewayMock.mockResolvedValue({ sessions: [{ key: "agent:main:subagent:one" }] });

    await expect(
      isResolvedSessionVisibleToRequester({
        requesterSessionKey: "agent:main:main",
        targetSessionKey: "agent:main:subagent:one",
        restrictToSpawned: true,
        resolvedViaSessionId: false,
      }),
    ).resolves.toBe(true);

    await expect(
      isResolvedSessionVisibleToRequester({
        requesterSessionKey: "agent:main:main",
        targetSessionKey: "agent:main:subagent:missing",
        restrictToSpawned: true,
        resolvedViaSessionId: false,
      }),
    ).resolves.toBe(false);

    expect(logWarnMock).not.toHaveBeenCalled();
  });
});
