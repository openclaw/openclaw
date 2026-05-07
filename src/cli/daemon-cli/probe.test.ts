import { describe, expect, it, vi } from "vitest";
import { probeGatewayStatus } from "./probe.js";

const callGatewayMock = vi.hoisted(() => vi.fn());
const probeGatewayMock = vi.hoisted(() => vi.fn());

vi.mock("../../gateway/call.js", () => ({
  callGateway: (...args: unknown[]) => callGatewayMock(...args),
}));

vi.mock("../../gateway/probe.js", () => ({
  probeGateway: (...args: unknown[]) => probeGatewayMock(...args),
}));

vi.mock("../progress.js", () => ({
  withProgress: async (_opts: unknown, fn: () => Promise<unknown>) => await fn(),
}));

describe("probeGatewayStatus", () => {
  const pairingPendingAuth = {
    role: null,
    scopes: [],
    capability: "pairing_pending",
  } as const;

  function mockPairingPendingCloseProbe(error: string | null) {
    probeGatewayMock.mockResolvedValueOnce({
      ok: false,
      error,
      close: { code: 1008, reason: "pairing required" },
      auth: pairingPendingAuth,
    });
  }

  function expectPairingPendingCloseResult(result: Awaited<ReturnType<typeof probeGatewayStatus>>) {
    expect(result).toEqual({
      ok: false,
      kind: "connect",
      capability: "pairing_pending",
      auth: pairingPendingAuth,
      error: "gateway closed (1008): pairing required",
    });
  }

  it("uses lightweight token-only probing for daemon status", async () => {
    callGatewayMock.mockReset();
    probeGatewayMock.mockResolvedValueOnce({
      ok: true,
      auth: {
        role: "operator",
        scopes: ["operator.write"],
        capability: "write_capable",
      },
    });

    const result = await probeGatewayStatus({
      url: "ws://127.0.0.1:19191",
      token: "temp-token",
      tlsFingerprint: "abc123",
      timeoutMs: 5_000,
      json: true,
    });

    expect(result).toEqual({
      ok: true,
      kind: "connect",
      capability: "write_capable",
      auth: {
        role: "operator",
        scopes: ["operator.write"],
        capability: "write_capable",
      },
    });
    expect(callGatewayMock).not.toHaveBeenCalled();
    expect(probeGatewayMock).toHaveBeenCalledWith({
      url: "ws://127.0.0.1:19191",
      auth: {
        token: "temp-token",
        password: undefined,
      },
      tlsFingerprint: "abc123",
      timeoutMs: 5_000,
      includeDetails: false,
    });
  });

  it("uses a bounded local status RPC fallback when the default probe times out", async () => {
    callGatewayMock.mockReset();
    probeGatewayMock.mockReset();
    probeGatewayMock.mockResolvedValueOnce({
      ok: false,
      error: "timeout",
      close: null,
      auth: {
        role: null,
        scopes: [],
        capability: "unknown",
      },
    });
    callGatewayMock.mockResolvedValueOnce({ status: "ok" });
    const config = { gateway: { mode: "local" } } as const;

    const result = await probeGatewayStatus({
      url: "wss://127.0.0.1:19191",
      token: "temp-token",
      config,
      tlsFingerprint: "abc123",
      timeoutMs: 5_000,
      json: true,
      configPath: "/tmp/openclaw-daemon/openclaw.json",
    });

    expect(result).toEqual({
      ok: true,
      kind: "connect",
      capability: "read_only",
      auth: {
        role: null,
        scopes: [],
        capability: "read_only",
      },
    });
    expect(callGatewayMock).toHaveBeenCalledWith({
      url: "wss://127.0.0.1:19191",
      token: "temp-token",
      password: undefined,
      tlsFingerprint: "abc123",
      config,
      method: "status",
      timeoutMs: 1000,
      mode: "backend",
      clientName: "gateway-client",
      configPath: "/tmp/openclaw-daemon/openclaw.json",
    });
  });

  it("uses shared credentials for local loopback status RPC fallback", async () => {
    callGatewayMock.mockReset();
    probeGatewayMock.mockReset();
    probeGatewayMock.mockResolvedValueOnce({
      ok: false,
      error: "timeout",
      close: null,
      auth: {
        role: null,
        scopes: [],
        capability: "unknown",
      },
    });
    callGatewayMock.mockResolvedValueOnce({ status: "ok" });

    const result = await probeGatewayStatus({
      url: "ws://127.0.0.1:19191",
      token: "temp-token",
      timeoutMs: 5_000,
      json: true,
    });

    expect(result).toEqual({
      ok: true,
      kind: "connect",
      capability: "read_only",
      auth: {
        role: null,
        scopes: [],
        capability: "read_only",
      },
    });
    expect(callGatewayMock).toHaveBeenCalledWith({
      url: "ws://127.0.0.1:19191",
      token: "temp-token",
      password: undefined,
      tlsFingerprint: undefined,
      method: "status",
      timeoutMs: 1000,
      mode: "backend",
      clientName: "gateway-client",
    });
  });

  it("uses paired-device auth for authenticated local loopback status RPC fallback", async () => {
    callGatewayMock.mockReset();
    probeGatewayMock.mockReset();
    probeGatewayMock.mockResolvedValueOnce({
      ok: false,
      error: "timeout",
      close: null,
      auth: {
        role: "operator",
        scopes: ["operator.read"],
        capability: "read_only",
      },
    });
    callGatewayMock.mockResolvedValueOnce({ status: "ok" });

    const result = await probeGatewayStatus({
      url: "ws://127.0.0.1:19191",
      timeoutMs: 5_000,
      json: true,
    });

    expect(result).toEqual({
      ok: true,
      kind: "connect",
      capability: "read_only",
      auth: {
        role: "operator",
        scopes: ["operator.read"],
        capability: "read_only",
      },
    });
    expect(callGatewayMock).toHaveBeenCalledWith({
      url: "ws://127.0.0.1:19191",
      token: undefined,
      password: undefined,
      tlsFingerprint: undefined,
      method: "status",
      timeoutMs: 1000,
      mode: "backend",
      clientName: "gateway-client",
      allowDeviceIdentityLoopbackUrlOverride: true,
    });
  });

  it("uses a real status RPC when requireRpc is enabled", async () => {
    callGatewayMock.mockReset();
    probeGatewayMock.mockReset();
    callGatewayMock.mockResolvedValueOnce({ status: "ok" });
    probeGatewayMock.mockResolvedValueOnce({
      ok: true,
      auth: {
        role: "operator",
        scopes: ["operator.admin"],
        capability: "admin_capable",
      },
    });

    const result = await probeGatewayStatus({
      url: "ws://127.0.0.1:19191",
      token: "temp-token",
      tlsFingerprint: "abc123",
      timeoutMs: 5_000,
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
    });
    expect(probeGatewayMock).toHaveBeenCalledWith({
      url: "ws://127.0.0.1:19191",
      auth: {
        token: "temp-token",
        password: undefined,
      },
      tlsFingerprint: "abc123",
      timeoutMs: 5_000,
      includeDetails: false,
    });
    expect(callGatewayMock).toHaveBeenCalledWith({
      url: "ws://127.0.0.1:19191",
      token: "temp-token",
      password: undefined,
      tlsFingerprint: "abc123",
      method: "status",
      timeoutMs: 5_000,
      configPath: "/tmp/openclaw-daemon/openclaw.json",
    });
  });

  it("forwards configured handshake timeout to the connect probe and status RPC", async () => {
    callGatewayMock.mockReset();
    probeGatewayMock.mockReset();
    callGatewayMock.mockResolvedValueOnce({ status: "ok" });
    probeGatewayMock.mockResolvedValueOnce({
      ok: true,
      auth: {
        role: "operator",
        scopes: ["operator.admin"],
        capability: "admin_capable",
      },
    });
    const config = { gateway: { handshakeTimeoutMs: 30_000 } };

    await probeGatewayStatus({
      url: "ws://127.0.0.1:19191",
      token: "temp-token",
      config,
      preauthHandshakeTimeoutMs: 30_000,
      timeoutMs: 30_000,
      requireRpc: true,
    });

    expect(probeGatewayMock).toHaveBeenCalledWith(
      expect.objectContaining({
        preauthHandshakeTimeoutMs: 30_000,
        timeoutMs: 30_000,
      }),
    );
    expect(callGatewayMock).toHaveBeenCalledWith(
      expect.objectContaining({
        config,
        timeoutMs: 30_000,
      }),
    );
  });

  it("falls back to read-only when the status RPC succeeds but the auth probe is inconclusive", async () => {
    callGatewayMock.mockReset();
    probeGatewayMock.mockReset();
    callGatewayMock.mockResolvedValueOnce({ status: "ok" });
    probeGatewayMock.mockResolvedValueOnce({
      ok: true,
      auth: {
        role: null,
        scopes: [],
        capability: "unknown",
      },
    });

    const result = await probeGatewayStatus({
      url: "ws://127.0.0.1:19191",
      token: "temp-token",
      timeoutMs: 5_000,
      requireRpc: true,
    });

    expect(result).toEqual({
      ok: true,
      kind: "read",
      capability: "read_only",
      auth: {
        role: null,
        scopes: [],
        capability: "unknown",
      },
    });
  });

  it("surfaces probe close details when the handshake fails", async () => {
    callGatewayMock.mockReset();
    probeGatewayMock.mockReset();
    mockPairingPendingCloseProbe(null);

    const result = await probeGatewayStatus({
      url: "ws://127.0.0.1:19191",
      timeoutMs: 5_000,
    });

    expectPairingPendingCloseResult(result);
  });

  it("prefers the close reason over a generic timeout when both are present", async () => {
    callGatewayMock.mockReset();
    probeGatewayMock.mockReset();
    mockPairingPendingCloseProbe("timeout");

    const result = await probeGatewayStatus({
      url: "ws://127.0.0.1:19191",
      timeoutMs: 5_000,
    });

    expectPairingPendingCloseResult(result);
  });

  it("keeps actionable probe errors when the close reason stays generic", async () => {
    callGatewayMock.mockReset();
    probeGatewayMock.mockReset();
    probeGatewayMock.mockResolvedValueOnce({
      ok: false,
      error: "scope upgrade pending approval (requestId: req-123)",
      close: { code: 1008, reason: "pairing required" },
    });

    const result = await probeGatewayStatus({
      url: "ws://127.0.0.1:19191",
      timeoutMs: 5_000,
    });

    expect(result).toMatchObject({
      ok: false,
      kind: "connect",
      error: "scope upgrade pending approval (requestId: req-123)",
    });
  });

  it("surfaces status RPC errors when requireRpc is enabled", async () => {
    callGatewayMock.mockReset();
    probeGatewayMock.mockReset();
    callGatewayMock.mockRejectedValueOnce(new Error("missing scope: operator.admin"));

    const result = await probeGatewayStatus({
      url: "ws://127.0.0.1:19191",
      token: "temp-token",
      timeoutMs: 5_000,
      requireRpc: true,
    });

    expect(result).toEqual({
      ok: false,
      kind: "read",
      error: "missing scope: operator.admin",
    });
    expect(probeGatewayMock).not.toHaveBeenCalled();
  });
});
