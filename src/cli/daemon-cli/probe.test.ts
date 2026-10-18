// Daemon probe tests cover gateway probe command behavior and output.
import "../../test-utils/prepare-compiled-subprocesses.js";
import { assert, beforeEach, describe, expect, it, vi } from "vitest";
import { gatewayProbeResultSawGateway } from "../../commands/gateway-health-auth-diagnostic.js";
import { probeGatewayStatus } from "./probe.js";
import type { DaemonStatus } from "./status.gather.js";

const callGatewayMock = vi.hoisted(() => vi.fn());
const probeGatewayMock = vi.hoisted(() => vi.fn());

vi.mock("../../gateway/call.js", () => ({
  callGateway: (...args: unknown[]) => callGatewayMock(...args),
}));

vi.mock("../../gateway/probe.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../gateway/probe.js")>()),
  probeGateway: (...args: unknown[]) => probeGatewayMock(...args),
}));

vi.mock("../progress.js", () => ({
  withProgress: async (_opts: unknown, fn: () => Promise<unknown>) => await fn(),
}));

function createDaemonStatus(rpc: NonNullable<DaemonStatus["rpc"]>): DaemonStatus {
  return {
    service: {
      label: "test service",
      loaded: true,
      loadState: { status: "loaded" },
      loadedText: "loaded",
      notLoadedText: "not loaded",
    },
    rpc,
    extraServices: [],
  };
}

const probeDefaults = { url: "ws://127.0.0.1:19191", timeoutMs: 5_000 };
const credentialConfig = {
  gateway: {
    auth: { mode: "token", token: { source: "exec", provider: "vault", id: "gateway/token" } },
  },
  secrets: { providers: { vault: { source: "exec", command: "/bin/false" } } },
} as const;
const rpcDefaults = {
  token: "temp-token",
  password: undefined,
  tlsFingerprint: undefined,
  preauthHandshakeTimeoutMs: undefined,
  localPortOverride: undefined,
  method: "status",
  timeoutMs: 5_000,
  sharedStateMode: "read-only",
  skipImplicitAuth: true,
  serviceTargetUrl: probeDefaults.url,
  onHelloOk: expect.any(Function),
};
const probe = (options: Partial<Parameters<typeof probeGatewayStatus>[0]> = {}) =>
  probeGatewayStatus({ ...probeDefaults, ...options });

describe("probeGatewayStatus", () => {
  beforeEach(() => {
    callGatewayMock.mockReset();
    probeGatewayMock.mockReset();
  });
  const pairingPendingAuth = {
    role: null,
    scopes: [],
    capability: "pairing_pending",
  } as const;

  it("projects allowlisted connect failure details without serializing raw payloads", async () => {
    probeGatewayMock.mockResolvedValueOnce({
      ok: false,
      error: "connect failed",
      close: { code: 1008, reason: "connect failed" },
      connectErrorDetails: {
        code: "PAIRING_REQUIRED",
        reason: "scope-upgrade",
        secret: "do-not-print",
      },
      auth: pairingPendingAuth,
      gatewayReached: true,
    });

    const result = await probe({
      json: true,
    });

    assert(!result.ok);
    expect(result.connectFailure).toEqual({
      kind: "pairing-required",
      detailCode: "PAIRING_REQUIRED",
    });
    expect(result).not.toHaveProperty("connectErrorDetails");
    expect(gatewayProbeResultSawGateway(result)).toBe(true);

    const json = JSON.stringify(createDaemonStatus(result));
    expect(json).not.toContain("do-not-print");
    expect(json).not.toContain('"secret"');
    expect(json).not.toContain("scope-upgrade");
  });

  it("does not treat an unvalidated transport close as a Gateway response", async () => {
    probeGatewayMock.mockResolvedValueOnce({
      ok: false,
      error: "connect ECONNREFUSED 127.0.0.1:19191",
      close: { code: 1006, reason: "" },
    });

    const result = await probe({
      json: true,
    });

    assert(!result.ok);
    expect(gatewayProbeResultSawGateway(result)).toBe(false);
  });

  it("omits unknown detail codes from serialized daemon status", async () => {
    probeGatewayMock.mockResolvedValueOnce({
      ok: false,
      error: "connect failed",
      close: { code: 1008, reason: "connect failed" },
      connectErrorDetails: {
        code: "FUTURE_SENSITIVE_CODE",
        secret: "do-not-print-unknown",
      },
      auth: pairingPendingAuth,
    });

    const result = await probe({
      json: true,
    });

    assert(!result.ok);
    expect(result.connectFailure).toEqual({ kind: "gateway-rejected" });

    const json = JSON.stringify(createDaemonStatus(result));
    expect(json).not.toContain("FUTURE_SENSITIVE_CODE");
    expect(json).not.toContain("do-not-print-unknown");
  });

  it("uses one timeout-bound status RPC when requireRpc is enabled", async () => {
    callGatewayMock.mockImplementationOnce(async (opts) => {
      opts.onHelloOk?.({
        server: { version: "2026.8.1", buildId: "build-1", connId: "conn-1" },
        auth: { role: "operator", scopes: ["operator.admin"] },
      });
      return { runtimeVersion: "2026.8.1", status: "ok" };
    });

    const config = {};
    const result = await probe({
      config,
      timeoutMs: 30_000,
      preauthHandshakeTimeoutMs: 30_000,
      token: "temp-token",
      tlsFingerprint: "abc123",
      json: true,
      requireRpc: true,
      configPath: "/tmp/openclaw-daemon/openclaw.json",
    });

    expect(result).toEqual({
      ok: true,
      kind: "read",
      capability: "admin_capable",
      auth: {
        role: "operator",
        scopes: ["operator.admin"],
        capability: "admin_capable",
      },
      server: {
        version: "2026.8.1",
        buildId: "build-1",
        connId: "conn-1",
      },
      version: "2026.8.1",
    });
    expect(probeGatewayMock).not.toHaveBeenCalled();
    expect(callGatewayMock).toHaveBeenCalledOnce();
    expect(callGatewayMock).toHaveBeenCalledWith({
      ...rpcDefaults,
      config,
      timeoutMs: 30_000,
      preauthHandshakeTimeoutMs: 30_000,
      tlsFingerprint: "abc123",
      configPath: "/tmp/openclaw-daemon/openclaw.json",
    });
  });

  it("omits config-backed credentials from the status RPC when disabled", async () => {
    callGatewayMock.mockResolvedValueOnce({ status: "ok" });
    const config = credentialConfig;

    const result = await probe({
      token: "temp-token",
      config,
      requireRpc: true,
      allowRpcConfigCredentials: false,
    });

    expect(result).toMatchObject({ ok: true, capability: "read_only" });
    expect(callGatewayMock).toHaveBeenCalledWith(rpcDefaults);
  });

  it("fails before the status RPC when config credentials are disabled without explicit auth", async () => {
    const result = await probe({
      config: credentialConfig,
      requireRpc: true,
      allowRpcConfigCredentials: false,
    });

    expect(result).toEqual({
      ok: false,
      kind: "read",
      connectFailure: { kind: "unreachable" },
      error:
        "gateway status RPC skipped because configured gateway credentials are disabled for this status request",
    });
    expect(callGatewayMock).not.toHaveBeenCalled();
    expect(probeGatewayMock).not.toHaveBeenCalled();
  });

  it("prefers the close reason over a generic timeout when both are present", async () => {
    probeGatewayMock.mockResolvedValueOnce({
      ok: false,
      error: "timeout",
      close: { code: 1008, reason: "pairing required" },
      auth: pairingPendingAuth,
      gatewayReached: true,
    });

    const result = await probe({});

    expect(result).toEqual({
      ok: false,
      kind: "connect",
      capability: "pairing_pending",
      gatewayReached: true,
      auth: pairingPendingAuth,
      connectFailure: { kind: "pairing-required" },
      error: "gateway closed (1008): pairing required",
    });
  });

  it("redacts credential-bearing URLs echoed in probe failure text", async () => {
    probeGatewayMock.mockResolvedValueOnce({
      ok: false,
      error: "connect failed to ws://user:secret@gw.example.com:18789?token=abc123",
      close: null,
    });

    const result = await probe({});

    assert(!result.ok);
    expect(result.error).not.toContain("secret");
    expect(result.error).not.toContain("abc123");
    expect(result.error).toContain("ws://***:***@gw.example.com:18789?token=***");
  });

  it("redacts credential-bearing URLs in thrown probe errors", async () => {
    probeGatewayMock.mockRejectedValueOnce(
      new Error("dial ws://user:secret@gw.example.com:18789 refused"),
    );

    const result = await probe({});

    assert(!result.ok);
    expect(result.error).not.toContain("secret");
    expect(result.error).toContain("ws://***:***@gw.example.com:18789");
  });

  it("preserves event-loop evidence when an admitted status RPC times out", async () => {
    callGatewayMock.mockImplementationOnce(async (opts) => {
      opts.onHelloOk({
        auth: { role: "operator", scopes: ["operator.read"] },
        server: { version: "2026.9.17", connId: "conn-busy" },
        snapshot: {
          health: {
            eventLoop: {
              degraded: true,
              reasons: ["event_loop_delay", "event_loop_utilization"],
              intervalMs: 5_000,
              delayP99Ms: 5_079,
              delayMaxMs: 5_100,
              utilization: 1,
              cpuCoreRatio: 0.94,
            },
          },
        },
      });
      const error = new Error("gateway timeout after 5000ms");
      error.name = "GatewayTransportError";
      Object.assign(error, {
        kind: "timeout",
        connectionDetails: { url: "ws://127.0.0.1:19191" },
      });
      throw error;
    });

    const result = await probe({
      token: "temp-token",
      requireRpc: true,
    });

    expect(result).toMatchObject({
      ok: false,
      kind: "read",
      gatewayReached: true,
      timedOut: true,
      eventLoop: {
        degraded: true,
        delayP99Ms: 5_079,
        utilization: 1,
      },
    });
  });

  it("passes an explicit CLI --url override to callGateway", async () => {
    callGatewayMock.mockImplementationOnce(async (opts) => {
      opts.onHelloOk?.({
        server: { version: "2026.8.1", buildId: "build-1", connId: "conn-1" },
        auth: { role: "operator", scopes: ["operator.admin"] },
      });
      return { status: "ok" };
    });

    const urlOverride = "wss://explicit.example:19001";
    await probe({
      urlOverride,
      token: "explicit-token",
      requireRpc: true,
    });

    expect(callGatewayMock).toHaveBeenCalledOnce();
    expect(callGatewayMock).toHaveBeenCalledWith(expect.objectContaining({ url: urlOverride }));
    expect(callGatewayMock).toHaveBeenCalledWith(
      expect.not.objectContaining({ serviceTargetUrl: expect.anything() }),
    );
  });
});
