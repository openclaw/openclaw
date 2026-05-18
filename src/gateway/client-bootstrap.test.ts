import { beforeEach, describe, expect, it, vi } from "vitest";
import type { resolveGatewayConnectionAuth } from "./connection-auth.js";

type AuthResolutionParams = Parameters<typeof resolveGatewayConnectionAuth>[0];

const mockState = vi.hoisted(() => ({
  buildGatewayConnectionDetails: vi.fn(),
  loadGatewayTlsRuntime: vi.fn(),
  resolveGatewayConnectionAuth: vi.fn(),
}));

vi.mock("./connection-details.js", () => ({
  buildGatewayConnectionDetailsWithResolvers: (...args: unknown[]) =>
    mockState.buildGatewayConnectionDetails(...args),
}));

vi.mock("./connection-auth.js", () => ({
  resolveGatewayConnectionAuth: (...args: unknown[]) =>
    mockState.resolveGatewayConnectionAuth(...args),
}));

vi.mock("../infra/tls/gateway.js", () => ({
  loadGatewayTlsRuntime: (...args: unknown[]) => mockState.loadGatewayTlsRuntime(...args),
}));

const { resolveGatewayClientBootstrap, resolveGatewayUrlOverrideSource } =
  await import("./client-bootstrap.js");

function expectLastAuthResolutionParams(expected: {
  urlOverride?: string;
  urlOverrideSource?: "cli" | "env";
}) {
  const [params] = mockState.resolveGatewayConnectionAuth.mock.calls.at(-1) ?? [];
  if (params === undefined) {
    throw new Error("Expected shared auth resolution to be called");
  }
  const authParams = params as AuthResolutionParams;
  expect(authParams.env).toBe(process.env);
  expect(authParams.urlOverride).toBe(expected.urlOverride);
  expect(authParams.urlOverrideSource).toBe(expected.urlOverrideSource);
}

describe("resolveGatewayUrlOverrideSource", () => {
  it("maps override url sources only", () => {
    expect(resolveGatewayUrlOverrideSource("cli --url")).toBe("cli");
    expect(resolveGatewayUrlOverrideSource("env OPENCLAW_GATEWAY_URL")).toBe("env");
    expect(resolveGatewayUrlOverrideSource("config gateway.remote.url")).toBeUndefined();
  });
});

describe("resolveGatewayClientBootstrap", () => {
  beforeEach(() => {
    mockState.buildGatewayConnectionDetails.mockReset();
    mockState.loadGatewayTlsRuntime.mockReset();
    mockState.loadGatewayTlsRuntime.mockResolvedValue({ enabled: false, required: false });
    mockState.resolveGatewayConnectionAuth.mockReset();
    mockState.resolveGatewayConnectionAuth.mockResolvedValue({
      token: undefined,
      password: undefined,
    });
  });

  it("passes cli override context into shared auth resolution", async () => {
    mockState.buildGatewayConnectionDetails.mockReturnValueOnce({
      url: "wss://override.example/ws",
      urlSource: "cli --url",
    });

    const result = await resolveGatewayClientBootstrap({
      config: {} as never,
      gatewayUrl: "wss://override.example/ws",
      env: process.env,
    });

    expect(result).toEqual({
      url: "wss://override.example/ws",
      urlSource: "cli --url",
      preauthHandshakeTimeoutMs: undefined,
      auth: {
        token: undefined,
        password: undefined,
      },
    });
    expectLastAuthResolutionParams({
      urlOverride: "wss://override.example/ws",
      urlOverrideSource: "cli",
    });
  });

  it("does not mark config-derived urls as overrides", async () => {
    mockState.buildGatewayConnectionDetails.mockReturnValue({
      url: "wss://gateway.example/ws",
      urlSource: "config gateway.remote.url",
    });

    await resolveGatewayClientBootstrap({
      config: {} as never,
      env: process.env,
    });

    expectLastAuthResolutionParams({
      urlOverride: undefined,
      urlOverrideSource: undefined,
    });
  });

  it("carries configured preauth handshake timeout for GatewayClient callers", async () => {
    mockState.buildGatewayConnectionDetails.mockReturnValue({
      url: "ws://127.0.0.1:18789",
      urlSource: "local loopback",
    });

    const result = await resolveGatewayClientBootstrap({
      config: { gateway: { handshakeTimeoutMs: 30_000 } } as never,
      env: process.env,
    });

    expect(result.preauthHandshakeTimeoutMs).toBe(30_000);
  });

  it("uses the local gateway TLS fingerprint for config-derived local WSS clients", async () => {
    const tlsConfig = { enabled: true };
    mockState.buildGatewayConnectionDetails.mockReturnValue({
      url: "wss://127.0.0.1:18789",
      urlSource: "local loopback",
    });
    mockState.loadGatewayTlsRuntime.mockResolvedValue({
      enabled: true,
      required: true,
      fingerprintSha256: "sha256:local",
    });

    const result = await resolveGatewayClientBootstrap({
      config: { gateway: { tls: tlsConfig } } as never,
      env: process.env,
    });

    expect(result.tlsFingerprint).toBe("sha256:local");
    expect(mockState.loadGatewayTlsRuntime).toHaveBeenCalledWith(tlsConfig);
  });

  it("uses configured remote TLS fingerprint for remote env URL overrides", async () => {
    mockState.buildGatewayConnectionDetails.mockReturnValue({
      url: "wss://override.example/ws",
      urlSource: "env OPENCLAW_GATEWAY_URL",
    });

    const result = await resolveGatewayClientBootstrap({
      config: {
        gateway: {
          mode: "remote",
          remote: {
            url: "wss://gateway.example/ws",
            tlsFingerprint: "sha256:remote",
          },
        },
      } as never,
      env: process.env,
    });

    expect(result.tlsFingerprint).toBe("sha256:remote");
    expect(mockState.loadGatewayTlsRuntime).not.toHaveBeenCalled();
  });

  it("uses local TLS fingerprint for remote-mode local fallback", async () => {
    const tlsConfig = { enabled: true };
    mockState.buildGatewayConnectionDetails.mockReturnValue({
      url: "wss://127.0.0.1:18789",
      urlSource: "missing gateway.remote.url (fallback local)",
    });
    mockState.loadGatewayTlsRuntime.mockResolvedValue({
      enabled: true,
      required: true,
      fingerprintSha256: "sha256:local",
    });

    const result = await resolveGatewayClientBootstrap({
      config: {
        gateway: {
          mode: "remote",
          tls: tlsConfig,
          remote: {
            tlsFingerprint: "sha256:remote",
          },
        },
      } as never,
      env: process.env,
    });

    expect(result.tlsFingerprint).toBe("sha256:local");
    expect(mockState.loadGatewayTlsRuntime).toHaveBeenCalledWith(tlsConfig);
  });

  it("skips configured remote TLS fingerprint for non-WSS env URL overrides", async () => {
    mockState.buildGatewayConnectionDetails.mockReturnValue({
      url: "ws://127.0.0.1:18789",
      urlSource: "env OPENCLAW_GATEWAY_URL",
    });

    const result = await resolveGatewayClientBootstrap({
      config: {
        gateway: {
          mode: "remote",
          remote: {
            url: "wss://gateway.example/ws",
            tlsFingerprint: "sha256:remote",
          },
        },
      } as never,
      env: process.env,
    });

    expect(result.tlsFingerprint).toBeUndefined();
    expect(mockState.loadGatewayTlsRuntime).not.toHaveBeenCalled();
  });

  it("skips configured remote TLS fingerprint for non-WSS remote URLs", async () => {
    mockState.buildGatewayConnectionDetails.mockReturnValue({
      url: "ws://127.0.0.1:18789",
      urlSource: "config gateway.remote.url",
    });

    const result = await resolveGatewayClientBootstrap({
      config: {
        gateway: {
          mode: "remote",
          remote: {
            url: "ws://127.0.0.1:18789",
            tlsFingerprint: "sha256:remote",
          },
        },
      } as never,
      env: process.env,
    });

    expect(result.tlsFingerprint).toBeUndefined();
    expect(mockState.loadGatewayTlsRuntime).not.toHaveBeenCalled();
  });

  it("skips configured remote TLS fingerprint for CLI URL overrides", async () => {
    mockState.buildGatewayConnectionDetails.mockReturnValue({
      url: "wss://override.example/ws",
      urlSource: "cli --url",
    });

    const result = await resolveGatewayClientBootstrap({
      config: {
        gateway: {
          mode: "remote",
          remote: {
            url: "wss://gateway.example/ws",
            tlsFingerprint: "sha256:remote",
          },
        },
      } as never,
      gatewayUrl: "wss://override.example/ws",
      env: process.env,
    });

    expect(result.tlsFingerprint).toBeUndefined();
    expect(mockState.loadGatewayTlsRuntime).not.toHaveBeenCalled();
  });

  it("does not use local gateway TLS fingerprint for env URL overrides", async () => {
    mockState.buildGatewayConnectionDetails.mockReturnValue({
      url: "wss://override.example/ws",
      urlSource: "env OPENCLAW_GATEWAY_URL",
    });

    const result = await resolveGatewayClientBootstrap({
      config: { gateway: { tls: { enabled: true } } } as never,
      env: process.env,
    });

    expect(result.tlsFingerprint).toBeUndefined();
    expect(mockState.loadGatewayTlsRuntime).not.toHaveBeenCalled();
  });
});
