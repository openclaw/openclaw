// Covers configured SSH transport in security audit deep Gateway probes.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";

const mocks = vi.hoisted(() => {
  const tunnelStop = vi.fn(async () => undefined);
  return {
    tunnelStop,
    buildGatewayConnectionDetails: vi.fn((options: { allowConfiguredSshTransport?: boolean }) => {
      if (options.allowConfiguredSshTransport !== true) {
        throw new Error("missing configured SSH allowance");
      }
      return {
        url: "ws://203.0.113.10:18789",
        urlSource: "config gateway.remote.url",
        message: "Gateway target: ws://203.0.113.10:18789",
      };
    }),
    startGatewayRemoteSshTunnel: vi.fn(async () => ({
      url: "ws://127.0.0.1:41001",
      urlSource: "ssh tunnel",
      tunnel: { stop: tunnelStop },
    })),
    resolveGatewayProbeAuthSafe: vi.fn(() => ({ auth: { token: "remote-token" } })),
    resolveGatewayProbeTarget: vi.fn(() => ({ mode: "remote" })),
    probeGateway: vi.fn(async ({ url }: { url: string }) => ({
      ok: true,
      url,
      connectLatencyMs: 12,
      error: null,
      close: null,
      health: { ok: true },
      status: { ok: true },
      presence: null,
      configSnapshot: null,
    })),
  };
});

vi.mock("../gateway/call.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../gateway/call.js")>();
  return {
    ...actual,
    buildGatewayConnectionDetails: mocks.buildGatewayConnectionDetails,
  };
});

vi.mock("../gateway/probe-auth.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../gateway/probe-auth.js")>();
  return {
    ...actual,
    resolveGatewayProbeAuthSafe: mocks.resolveGatewayProbeAuthSafe,
    resolveGatewayProbeTarget: mocks.resolveGatewayProbeTarget,
  };
});

vi.mock("../gateway/probe.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../gateway/probe.js")>();
  return {
    ...actual,
    probeGateway: mocks.probeGateway,
  };
});

vi.mock("../gateway/ssh-transport.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../gateway/ssh-transport.js")>();
  return {
    ...actual,
    startGatewayRemoteSshTunnel: mocks.startGatewayRemoteSshTunnel,
  };
});

const { runSecurityAudit } = await import("./audit.js");

describe("security audit configured SSH Gateway deep probe", () => {
  beforeEach(() => {
    mocks.tunnelStop.mockClear();
    mocks.buildGatewayConnectionDetails.mockClear();
    mocks.startGatewayRemoteSshTunnel.mockReset();
    mocks.startGatewayRemoteSshTunnel.mockResolvedValue({
      url: "ws://127.0.0.1:41001",
      urlSource: "ssh tunnel",
      tunnel: { stop: mocks.tunnelStop },
    });
    mocks.resolveGatewayProbeAuthSafe.mockClear();
    mocks.resolveGatewayProbeTarget.mockClear();
    mocks.probeGateway.mockClear();
  });

  it("starts the configured SSH tunnel before probing a remote Gateway", async () => {
    const config: OpenClawConfig = {
      gateway: {
        mode: "remote",
        remote: {
          url: "ws://203.0.113.10:18789",
          sshTarget: "user@gateway.example",
          token: "remote-token",
        },
      },
    };

    const report = await runSecurityAudit({
      config,
      env: {},
      deep: true,
      includeFilesystem: false,
      includeChannelSecurity: false,
      loadPluginSecurityCollectors: false,
    });

    expect(mocks.buildGatewayConnectionDetails).toHaveBeenCalledWith({
      config,
      allowConfiguredSshTransport: true,
    });
    expect(mocks.startGatewayRemoteSshTunnel).toHaveBeenCalledWith({
      config,
      url: "ws://203.0.113.10:18789",
      urlSource: "config gateway.remote.url",
    });
    expect(mocks.probeGateway).toHaveBeenCalledWith({
      url: "ws://127.0.0.1:41001",
      auth: { token: "remote-token" },
      timeoutMs: 5000,
    });
    expect(mocks.tunnelStop).toHaveBeenCalledTimes(1);
    expect(report.deep?.gateway).toMatchObject({
      attempted: true,
      url: "ws://127.0.0.1:41001",
      ok: true,
      error: null,
    });
  });

  it("reports configured SSH tunnel startup failures as deep Gateway probe warnings", async () => {
    const config: OpenClawConfig = {
      gateway: {
        mode: "remote",
        remote: {
          url: "ws://203.0.113.10:18789",
          sshTarget: "user@gateway.example",
          token: "remote-token",
        },
      },
    };
    mocks.startGatewayRemoteSshTunnel.mockRejectedValueOnce(new Error("ssh auth failed"));

    const report = await runSecurityAudit({
      config,
      env: {},
      deep: true,
      includeFilesystem: false,
      includeChannelSecurity: false,
      loadPluginSecurityCollectors: false,
    });

    expect(mocks.probeGateway).not.toHaveBeenCalled();
    expect(report.deep?.gateway).toMatchObject({
      attempted: true,
      url: "ws://203.0.113.10:18789",
      ok: false,
      error: "ssh tunnel failed: ssh auth failed",
      close: null,
    });
    expect(report.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          checkId: "gateway.probe_failed",
          severity: "warn",
          detail: "ssh tunnel failed: ssh auth failed",
        }),
      ]),
    );
  });
});
