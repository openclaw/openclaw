import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_GATEWAY_PORT } from "../config/paths.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { SshTunnel } from "../infra/ssh-tunnel.js";
import {
  applyGatewaySshTunnelConnectionDetails,
  startGatewayRemoteSshTunnel,
} from "./ssh-transport.js";

const mocks = vi.hoisted(() => ({
  startSshPortForward: vi.fn(),
}));

vi.mock("../infra/ssh-tunnel.js", () => ({
  startSshPortForward: mocks.startSshPortForward,
}));

describe("startGatewayRemoteSshTunnel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.startSshPortForward.mockResolvedValue({
      parsedTarget: { user: "user", host: "gateway.example", port: 22 },
      localPort: 19089,
      remotePort: DEFAULT_GATEWAY_PORT,
      pid: null,
      stderr: [],
      stop: vi.fn(async () => undefined),
    } satisfies SshTunnel);
  });

  it("defaults the remote SSH port to the gateway default when only the local tunnel URL has a port", async () => {
    const config = {
      gateway: {
        mode: "remote",
        remote: {
          url: "ws://127.0.0.1:19089",
          transport: "ssh",
          sshTarget: "user@gateway.example",
        },
      },
    } satisfies OpenClawConfig;

    const result = await startGatewayRemoteSshTunnel({
      config,
      url: "ws://127.0.0.1:19089",
      urlSource: "config gateway.remote.url",
    });

    expect(mocks.startSshPortForward).toHaveBeenCalledWith({
      target: "user@gateway.example",
      identity: undefined,
      localPortPreferred: 19089,
      remotePort: DEFAULT_GATEWAY_PORT,
      timeoutMs: 5000,
    });
    expect(result?.url).toBe("ws://127.0.0.1:19089");
  });

  it("ignores configured remote SSH ports outside the valid TCP range", async () => {
    const config = {
      gateway: {
        mode: "remote",
        remote: {
          url: "ws://127.0.0.1:19089",
          transport: "ssh",
          remotePort: 70_000,
          sshTarget: "user@gateway.example",
        },
      },
    } satisfies OpenClawConfig;

    await startGatewayRemoteSshTunnel({
      config,
      url: "ws://127.0.0.1:19089",
      urlSource: "config gateway.remote.url",
    });

    expect(mocks.startSshPortForward).toHaveBeenCalledWith(
      expect.objectContaining({ remotePort: DEFAULT_GATEWAY_PORT }),
    );
  });

  it("preserves the configured URL path when rewriting to a local tunnel", async () => {
    const config = {
      gateway: {
        mode: "remote",
        remote: {
          url: "ws://remote.example.com:18789/ws",
          transport: "ssh",
          sshTarget: "user@gateway.example",
        },
      },
    } satisfies OpenClawConfig;

    const result = await startGatewayRemoteSshTunnel({
      config,
      url: "ws://remote.example.com:18789/ws",
      urlSource: "config gateway.remote.url",
    });

    expect(result?.url).toBe("ws://127.0.0.1:19089/ws");
  });

  it.each(["not a url", "https://remote.example.com:18789"])(
    "rejects invalid configured URLs before starting an SSH tunnel (%s)",
    async (url) => {
      const config = {
        gateway: {
          mode: "remote",
          remote: {
            url,
            transport: "ssh",
            sshTarget: "user@gateway.example",
          },
        },
      } satisfies OpenClawConfig;

      await expect(
        startGatewayRemoteSshTunnel({
          config,
          url,
          urlSource: "config gateway.remote.url",
        }),
      ).rejects.toThrow("Invalid Gateway URL");
      expect(mocks.startSshPortForward).not.toHaveBeenCalled();
    },
  );

  it("keeps configured target details separate from temporary SSH tunnel URLs", () => {
    const result = applyGatewaySshTunnelConnectionDetails({
      details: {
        url: "ws://remote.example.com:18789",
        urlSource: "config gateway.remote.url",
        message: [
          "Gateway target: ws://remote.example.com:18789",
          "Source: config gateway.remote.url",
          "Config: /tmp/openclaw.json",
        ].join("\n"),
      },
      ssh: {
        url: "ws://127.0.0.1:19091",
        urlSource: "config gateway.remote.url via ssh tunnel",
        tunnel: {
          parsedTarget: { user: "user", host: "gateway.example", port: 22 },
          localPort: 19091,
          remotePort: DEFAULT_GATEWAY_PORT,
          pid: 1234,
          stderr: [],
          stop: vi.fn(async () => undefined),
        },
      },
    });

    expect(result.url).toBe("ws://127.0.0.1:19091");
    expect(result.message).toContain("Gateway target: ws://remote.example.com:18789");
    expect(result.message).toContain("Source: config gateway.remote.url");
    expect(result.message).toContain("Transport: configured SSH tunnel");
    expect(result.message).not.toContain("ws://127.0.0.1:19091");
  });
});
