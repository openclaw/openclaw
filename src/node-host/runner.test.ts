/** Tests node-host runner command parsing, timeout, and plugin dispatch behavior. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayClientOptions } from "../gateway/client.js";
import {
  resolveNodeHostGatewayDeviceFamily,
  resolveNodeHostGatewayPlatform,
  runNodeHost,
} from "./runner.js";

const mocks = vi.hoisted(() => ({
  capturedGatewayClientOptions: [] as GatewayClientOptions[],
  capturedGatewayClients: [] as Array<{ request: ReturnType<typeof vi.fn> }>,
  ensureNodeHostConfig: vi.fn(async () => ({
    version: 1,
    nodeId: "node-test",
  })),
  saveNodeHostConfig: vi.fn(async () => undefined),
  getRuntimeConfig: vi.fn(() => ({
    gateway: {
      handshakeTimeoutMs: 1_000,
    },
  })),
  startGatewayClientWhenEventLoopReady: vi.fn(async () => ({
    ready: false,
    aborted: false,
    elapsedMs: 0,
  })),
}));

vi.mock("../config/config.js", () => ({
  getRuntimeConfig: mocks.getRuntimeConfig,
}));

vi.mock("../gateway/client-start-readiness.js", () => ({
  startGatewayClientWhenEventLoopReady: mocks.startGatewayClientWhenEventLoopReady,
}));

vi.mock("../gateway/client.js", () => ({
  GatewayClient: function GatewayClient(opts: GatewayClientOptions) {
    const client = {
      request: vi.fn(async () => ({})),
    };
    mocks.capturedGatewayClientOptions.push(opts);
    mocks.capturedGatewayClients.push(client);
    return client;
  },
}));

vi.mock("../gateway/connection-auth.js", () => ({
  resolveGatewayConnectionAuth: vi.fn(async () => ({})),
}));

vi.mock("../infra/device-identity.js", () => ({
  loadOrCreateDeviceIdentity: vi.fn(() => ({
    id: "device-test",
    publicKey: "public-key-test",
    privateKey: "private-key-test",
  })),
}));

vi.mock("../infra/machine-name.js", () => ({
  getMachineDisplayName: vi.fn(async () => "test-node"),
}));

vi.mock("../infra/path-env.js", () => ({
  ensureOpenClawCliOnPath: vi.fn(),
}));

vi.mock("./config.js", () => ({
  ensureNodeHostConfig: mocks.ensureNodeHostConfig,
  saveNodeHostConfig: mocks.saveNodeHostConfig,
}));

vi.mock("./plugin-node-host.js", () => ({
  ensureNodeHostPluginRegistry: vi.fn(async () => undefined),
  listRegisteredNodeHostCapsAndCommands: vi.fn(() => ({
    caps: [],
    commands: [],
    nodePluginTools: [
      {
        pluginId: "test-plugin",
        name: "remote_echo",
        description: "Echo from node host",
        command: "test.echo",
        parameters: { type: "object", properties: {} },
      },
    ],
  })),
}));

describe("runNodeHost", () => {
  beforeEach(() => {
    mocks.capturedGatewayClientOptions.length = 0;
    mocks.capturedGatewayClients.length = 0;
    vi.clearAllMocks();
  });

  it("maps runtime platforms to gateway platform ids", () => {
    expect(resolveNodeHostGatewayPlatform("darwin")).toBe("macos");
    expect(resolveNodeHostGatewayPlatform("win32")).toBe("windows");
    expect(resolveNodeHostGatewayPlatform("linux")).toBe("linux");
    expect(resolveNodeHostGatewayPlatform("freebsd")).toBe("unknown");
    expect(resolveNodeHostGatewayDeviceFamily("darwin")).toBe("Mac");
    expect(resolveNodeHostGatewayDeviceFamily("win32")).toBe("Windows");
    expect(resolveNodeHostGatewayDeviceFamily("linux")).toBe("Linux");
    expect(resolveNodeHostGatewayDeviceFamily("freebsd")).toBeUndefined();
  });

  it("passes the resolved Gateway URL to the Gateway client", async () => {
    await expect(
      runNodeHost({
        gatewayHost: "127.0.0.1",
        gatewayPort: 18789,
      }),
    ).rejects.toThrow("event loop readiness timeout");

    expect(mocks.capturedGatewayClientOptions).toHaveLength(1);
    expect(mocks.capturedGatewayClientOptions[0]?.url).toBe("ws://127.0.0.1:18789");
    expect(mocks.capturedGatewayClientOptions[0]?.platform).toBe(
      resolveNodeHostGatewayPlatform(process.platform),
    );
    expect(mocks.capturedGatewayClientOptions[0]?.deviceFamily).toBe(
      resolveNodeHostGatewayDeviceFamily(process.platform),
    );
    expect(mocks.capturedGatewayClients[0]?.request).not.toHaveBeenCalled();
  });

  it("publishes node plugin tools only after gateway hello succeeds", async () => {
    await expect(
      runNodeHost({
        gatewayHost: "127.0.0.1",
        gatewayPort: 18789,
      }),
    ).rejects.toThrow("event loop readiness timeout");

    const options = mocks.capturedGatewayClientOptions[0];
    const client = mocks.capturedGatewayClients[0];
    expect(client?.request).not.toHaveBeenCalled();

    options?.onHelloOk?.({
      protocol: 1,
      features: { methods: [], events: [] },
    } as unknown as Parameters<NonNullable<GatewayClientOptions["onHelloOk"]>>[0]);

    expect(client?.request).toHaveBeenCalledWith("node.pluginTools.update", {
      tools: [
        {
          pluginId: "test-plugin",
          name: "remote_echo",
          description: "Echo from node host",
          command: "test.echo",
          parameters: { type: "object", properties: {} },
        },
      ],
    });
  });
});
