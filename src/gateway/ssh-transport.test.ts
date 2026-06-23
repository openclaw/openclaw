import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_GATEWAY_PORT } from "../config/paths.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { SshTunnel } from "../infra/ssh-tunnel.js";
import { startGatewayRemoteSshTunnel } from "./ssh-transport.js";

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
});
