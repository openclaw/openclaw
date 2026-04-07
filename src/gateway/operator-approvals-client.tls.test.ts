import { beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
  gatewayClientSpy: vi.fn(),
  resolveBootstrapSpy: vi.fn(),
  loadGatewayTlsRuntimeSpy: vi.fn(),
}));

vi.mock("./client.js", () => ({
  GatewayClient: class GatewayClientMock {
    constructor(opts: unknown) {
      hoisted.gatewayClientSpy(opts);
      return opts as object;
    }
  },
}));

vi.mock("./client-bootstrap.js", () => ({
  resolveGatewayClientBootstrap: hoisted.resolveBootstrapSpy,
  resolveGatewayUrlOverrideSource: (urlSource: string) => {
    if (urlSource === "cli --url") {
      return "cli";
    }
    if (urlSource === "env OPENCLAW_GATEWAY_URL") {
      return "env";
    }
    return undefined;
  },
}));

vi.mock("../infra/tls/gateway.js", () => ({
  loadGatewayTlsRuntime: hoisted.loadGatewayTlsRuntimeSpy,
}));

describe("createOperatorApprovalsGatewayClient TLS fingerprint", () => {
  beforeEach(() => {
    hoisted.gatewayClientSpy.mockReset();
    hoisted.resolveBootstrapSpy.mockReset().mockResolvedValue({
      url: "wss://127.0.0.1:18789",
      urlSource: "local loopback",
      auth: { token: "token-1", password: undefined },
    });
    hoisted.loadGatewayTlsRuntimeSpy.mockReset().mockResolvedValue({
      enabled: true,
      fingerprintSha256: "local-fingerprint",
    });
  });

  it("pins local TLS fingerprint for local loopback WSS", async () => {
    const { createOperatorApprovalsGatewayClient } = await import("./operator-approvals-client.js");

    await createOperatorApprovalsGatewayClient({
      config: {
        gateway: { mode: "local", bind: "lan", tls: { enabled: true } },
      } as never,
      clientDisplayName: "Telegram Exec Approvals (default)",
    });

    expect(hoisted.loadGatewayTlsRuntimeSpy).toHaveBeenCalledTimes(1);
    expect(hoisted.gatewayClientSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "wss://127.0.0.1:18789",
        token: "token-1",
        tlsFingerprint: "local-fingerprint",
      }),
    );
  });

  it("uses remote tlsFingerprint for env URL overrides", async () => {
    hoisted.resolveBootstrapSpy.mockResolvedValue({
      url: "wss://gateway-in-container.internal:9443/ws",
      urlSource: "env OPENCLAW_GATEWAY_URL",
      auth: { token: "token-1", password: undefined },
    });

    const { createOperatorApprovalsGatewayClient } = await import("./operator-approvals-client.js");

    await createOperatorApprovalsGatewayClient({
      config: {
        gateway: {
          mode: "remote",
          remote: {
            url: "wss://remote.example:9443/ws",
            tlsFingerprint: "remote-fingerprint",
          },
        },
      } as never,
      clientDisplayName: "Telegram Exec Approvals (default)",
    });

    expect(hoisted.loadGatewayTlsRuntimeSpy).not.toHaveBeenCalled();
    expect(hoisted.gatewayClientSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "wss://gateway-in-container.internal:9443/ws",
        tlsFingerprint: "remote-fingerprint",
      }),
    );
  });

  it("does not apply remote tlsFingerprint for CLI URL overrides", async () => {
    hoisted.resolveBootstrapSpy.mockResolvedValue({
      url: "wss://override.local:18789",
      urlSource: "cli --url",
      auth: { token: "token-1", password: undefined },
    });

    const { createOperatorApprovalsGatewayClient } = await import("./operator-approvals-client.js");

    await createOperatorApprovalsGatewayClient({
      config: {
        gateway: {
          mode: "remote",
          remote: {
            url: "wss://remote.example:9443/ws",
            tlsFingerprint: "remote-fingerprint",
          },
        },
      } as never,
      clientDisplayName: "Telegram Exec Approvals (default)",
    });

    expect(hoisted.loadGatewayTlsRuntimeSpy).not.toHaveBeenCalled();
    expect(hoisted.gatewayClientSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "wss://override.local:18789",
        tlsFingerprint: undefined,
      }),
    );
  });
});
