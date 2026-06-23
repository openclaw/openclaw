// Gateway client bootstrap tests keep URL override provenance wired into shared
// auth resolution so CLI and env callers authenticate against the intended target.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { resolveGatewayConnectionAuth } from "./connection-auth.js";

type AuthResolutionParams = Parameters<typeof resolveGatewayConnectionAuth>[0];

const mockState = vi.hoisted(() => ({
  buildGatewayConnectionDetails: vi.fn(),
  resolveGatewayConnectionAuth: vi.fn(),
  startSshPortForward: vi.fn(),
  stopSshTunnel: vi.fn(),
}));

vi.mock("./connection-details.js", () => ({
  buildGatewayConnectionDetailsWithResolvers: (...args: unknown[]) =>
    mockState.buildGatewayConnectionDetails(...args),
}));

vi.mock("./connection-auth.js", () => ({
  resolveGatewayConnectionAuth: (...args: unknown[]) =>
    mockState.resolveGatewayConnectionAuth(...args),
}));

vi.mock("../infra/ssh-tunnel.js", () => ({
  startSshPortForward: (...args: unknown[]) => mockState.startSshPortForward(...args),
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
    mockState.resolveGatewayConnectionAuth.mockReset();
    mockState.startSshPortForward.mockReset();
    mockState.stopSshTunnel.mockReset();
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

  it("opens an SSH tunnel and returns the local tunnel URL for configured SSH transport", async () => {
    mockState.buildGatewayConnectionDetails.mockReturnValue({
      url: "ws://remote.example.com:18789",
      urlSource: "config gateway.remote.url",
    });
    mockState.startSshPortForward.mockResolvedValue({
      parsedTarget: { user: "user", host: "gateway.example", port: 22 },
      localPort: 19091,
      remotePort: 18789,
      pid: 1234,
      stderr: [],
      stop: mockState.stopSshTunnel,
    });

    const result = await resolveGatewayClientBootstrap({
      config: {
        gateway: {
          mode: "remote",
          remote: {
            url: "ws://remote.example.com:18789",
            transport: "ssh",
            sshTarget: "user@gateway.example",
            sshIdentity: "~/.ssh/id_ed25519",
          },
        },
      } as never,
      env: process.env,
    });

    expect(mockState.startSshPortForward).toHaveBeenCalledWith({
      target: "user@gateway.example",
      identity: "~/.ssh/id_ed25519",
      localPortPreferred: 18789,
      remotePort: 18789,
      timeoutMs: expect.any(Number),
    });
    expect(result.url).toBe("ws://127.0.0.1:19091");
    expect(result.urlSource).toBe("config gateway.remote.url via ssh tunnel");
    expect(result.sshTunnel?.stop).toBe(mockState.stopSshTunnel);
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
});
