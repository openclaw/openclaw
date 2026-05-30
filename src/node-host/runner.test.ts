import { describe, expect, it, vi } from "vitest";
import type { GatewayClientOptions } from "../gateway/client.js";
import {
  resolveNodeHostGatewayDeviceFamily,
  resolveNodeHostGatewayPlatform,
  runNodeHost,
} from "./runner.js";

type TestNodeHostConfig = {
  version: 1;
  nodeId: string;
  nodeIdSource?: "generated" | "user";
};

const mocks = vi.hoisted(() => ({
  capturedGatewayClientOptions: [] as GatewayClientOptions[],
  ensureNodeHostConfig: vi.fn(
    async (): Promise<TestNodeHostConfig> => ({
      version: 1,
      nodeId: "node-test",
    }),
  ),
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
    mocks.capturedGatewayClientOptions.push(opts);
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
  })),
}));

describe("runNodeHost", () => {
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
    expect(mocks.capturedGatewayClientOptions[0]?.signInstanceId).toBe(false);
  });

  it("signs instanceId for an explicit node id override", async () => {
    await expect(
      runNodeHost({
        gatewayHost: "127.0.0.1",
        gatewayPort: 18789,
        nodeId: " custom-node-id ",
      }),
    ).rejects.toThrow("event loop readiness timeout");

    const opts = mocks.capturedGatewayClientOptions.at(-1);
    expect(opts?.instanceId).toBe("custom-node-id");
    expect(opts?.signInstanceId).toBe(true);
    expect(mocks.saveNodeHostConfig).toHaveBeenLastCalledWith(
      expect.objectContaining({
        nodeId: "custom-node-id",
        nodeIdSource: "user",
      }),
    );
  });

  it("keeps signing a persisted user node id on restart", async () => {
    mocks.ensureNodeHostConfig.mockResolvedValueOnce({
      version: 1,
      nodeId: "custom-node-id",
      nodeIdSource: "user",
    });

    await expect(
      runNodeHost({
        gatewayHost: "127.0.0.1",
        gatewayPort: 18789,
      }),
    ).rejects.toThrow("event loop readiness timeout");

    const opts = mocks.capturedGatewayClientOptions.at(-1);
    expect(opts?.instanceId).toBe("custom-node-id");
    expect(opts?.signInstanceId).toBe(true);
  });

  it("does not sign generated node ids by default", async () => {
    mocks.ensureNodeHostConfig.mockResolvedValueOnce({
      version: 1,
      nodeId: "92b639fe-3b09-44d4-9f32-22dd794b9e84",
      nodeIdSource: "generated",
    });

    await expect(
      runNodeHost({
        gatewayHost: "127.0.0.1",
        gatewayPort: 18789,
      }),
    ).rejects.toThrow("event loop readiness timeout");

    const opts = mocks.capturedGatewayClientOptions.at(-1);
    expect(opts?.instanceId).toBe("92b639fe-3b09-44d4-9f32-22dd794b9e84");
    expect(opts?.signInstanceId).toBe(false);
  });
});
