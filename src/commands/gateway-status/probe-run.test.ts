import { beforeEach, describe, expect, it, vi } from "vitest";
import { runGatewayStatusProbePass } from "./probe-run.js";

const mocks = vi.hoisted(() => ({
  callGateway: vi.fn(),
  discoverGatewayBeacons: vi.fn(),
  probeGateway: vi.fn(),
}));

vi.mock("../../gateway/call.js", () => ({
  callGateway: mocks.callGateway,
}));

vi.mock("../../gateway/probe.js", () => ({
  probeGateway: mocks.probeGateway,
}));

vi.mock("../../infra/bonjour-discovery.js", () => ({
  discoverGatewayBeacons: mocks.discoverGatewayBeacons,
}));

describe("runGatewayStatusProbePass", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.discoverGatewayBeacons.mockResolvedValue([]);
  });

  it("uses a bounded local status RPC fallback for local loopback probe timeouts", async () => {
    mocks.probeGateway.mockResolvedValueOnce({
      ok: false,
      url: "ws://127.0.0.1:18789",
      connectLatencyMs: null,
      error: "timeout",
      close: null,
      auth: {
        role: null,
        scopes: [],
        capability: "unknown",
      },
      health: null,
      status: null,
      presence: null,
      configSnapshot: null,
    });
    mocks.callGateway.mockResolvedValueOnce({ sessions: 1 });

    const result = await runGatewayStatusProbePass({
      cfg: {},
      opts: {},
      overallTimeoutMs: 8_000,
      discoveryTimeoutMs: 10,
      baseTargets: [
        {
          id: "localLoopback",
          kind: "localLoopback",
          url: "ws://127.0.0.1:18789",
          active: true,
        },
      ],
      remotePort: 18789,
      sshTarget: null,
      sshIdentity: null,
      loadSshTunnelModule: vi.fn(),
    });

    expect(mocks.callGateway).toHaveBeenCalledWith(
      expect.objectContaining({
        config: {},
        url: "ws://127.0.0.1:18789",
        token: undefined,
        password: undefined,
        method: "status",
        timeoutMs: 1000,
        mode: "backend",
        clientName: "gateway-client",
        deviceIdentity: null,
        allowUnauthenticatedLoopbackUrlOverride: true,
      }),
    );
    expect(result.probed[0]?.probe).toMatchObject({
      ok: true,
      error: "timeout",
      status: { sessions: 1 },
      auth: { capability: "read_only" },
    });
  });

  it("does not use the status RPC fallback with shared credentials on unpinned loopback", async () => {
    mocks.probeGateway.mockResolvedValueOnce({
      ok: false,
      url: "ws://127.0.0.1:18789",
      connectLatencyMs: null,
      error: "timeout",
      close: null,
      auth: {
        role: null,
        scopes: [],
        capability: "unknown",
      },
      health: null,
      status: null,
      presence: null,
      configSnapshot: null,
    });

    const result = await runGatewayStatusProbePass({
      cfg: {},
      opts: { token: "tok", password: "pw" },
      overallTimeoutMs: 8_000,
      discoveryTimeoutMs: 10,
      baseTargets: [
        {
          id: "localLoopback",
          kind: "localLoopback",
          url: "ws://127.0.0.1:18789",
          active: true,
        },
      ],
      remotePort: 18789,
      sshTarget: null,
      sshIdentity: null,
      loadSshTunnelModule: vi.fn(),
    });

    expect(mocks.callGateway).not.toHaveBeenCalled();
    expect(result.probed[0]?.probe).toMatchObject({
      ok: false,
      error: "timeout",
      auth: { capability: "unknown" },
    });
  });

  it("does not use the status RPC fallback for remote probe failures", async () => {
    mocks.probeGateway.mockResolvedValueOnce({
      ok: false,
      url: "wss://gateway.example/ws",
      connectLatencyMs: null,
      error: "timeout",
      close: null,
      auth: {
        role: null,
        scopes: [],
        capability: "unknown",
      },
      health: null,
      status: null,
      presence: null,
      configSnapshot: null,
    });

    const result = await runGatewayStatusProbePass({
      cfg: {},
      opts: {},
      overallTimeoutMs: 8_000,
      discoveryTimeoutMs: 10,
      baseTargets: [
        {
          id: "configRemote",
          kind: "configRemote",
          url: "wss://gateway.example/ws",
          active: true,
        },
      ],
      remotePort: 18789,
      sshTarget: null,
      sshIdentity: null,
      loadSshTunnelModule: vi.fn(),
    });

    expect(mocks.callGateway).not.toHaveBeenCalled();
    expect(result.probed[0]?.probe).toMatchObject({
      ok: false,
      error: "timeout",
    });
  });
});
