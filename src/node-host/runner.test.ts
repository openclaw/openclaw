/** Tests node-host runner command parsing, timeout, and plugin dispatch behavior. */
import { describe, expect, it, vi } from "vitest";
import type { GatewayClientOptions } from "../gateway/client.js";
import {
  resolveNodeHostGatewayDeviceFamily,
  resolveNodeHostGatewayPlatform,
  runNodeHost,
} from "./runner.js";

const mocks = vi.hoisted(() => ({
  capturedGatewayClientOptions: [] as GatewayClientOptions[],
  capturedSavedGatewayConfigs: [] as Array<{ contextPath?: string }>,
  ensureNodeHostConfig: vi.fn(async () => ({
    version: 1,
    nodeId: "node-test",
  })),
  saveNodeHostConfig: vi.fn(async (cfg: { gateway?: { contextPath?: string } }) => {
    if (cfg?.gateway) {
      mocks.capturedSavedGatewayConfigs.push(cfg.gateway);
    }
    return undefined;
  }),
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

function lastCapturedOptions(): GatewayClientOptions | undefined {
  const list = mocks.capturedGatewayClientOptions;
  return list[list.length - 1];
}

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
  });

  it("appends context path to the Gateway WebSocket URL", async () => {
    await expect(
      runNodeHost({
        gatewayHost: "127.0.0.1",
        gatewayPort: 18789,
        gatewayContextPath: "/gws",
      }),
    ).rejects.toThrow("event loop readiness timeout");

    expect(lastCapturedOptions()?.url).toBe("ws://127.0.0.1:18789/gws");
  });

  it("preserves trailing slash in context path as-is", async () => {
    await expect(
      runNodeHost({
        gatewayHost: "127.0.0.1",
        gatewayPort: 18789,
        gatewayContextPath: "/gws/",
      }),
    ).rejects.toThrow("event loop readiness timeout");

    expect(lastCapturedOptions()?.url).toBe("ws://127.0.0.1:18789/gws/");
  });

  it("prepends leading slash when context path is missing one", async () => {
    await expect(
      runNodeHost({
        gatewayHost: "127.0.0.1",
        gatewayPort: 18789,
        gatewayContextPath: "gws",
      }),
    ).rejects.toThrow("event loop readiness timeout");

    expect(lastCapturedOptions()?.url).toBe("ws://127.0.0.1:18789/gws");
  });

  it("omits context path when empty or undefined", async () => {
    await expect(
      runNodeHost({
        gatewayHost: "127.0.0.1",
        gatewayPort: 18789,
        gatewayContextPath: "",
      }),
    ).rejects.toThrow("event loop readiness timeout");

    expect(lastCapturedOptions()?.url).toBe("ws://127.0.0.1:18789");
  });

  it("saves the gateway config with contextPath to node.json", async () => {
    await expect(
      runNodeHost({
        gatewayHost: "127.0.0.1",
        gatewayPort: 18789,
        gatewayContextPath: "/gws",
      }),
    ).rejects.toThrow("event loop readiness timeout");

    const lastSaved =
      mocks.capturedSavedGatewayConfigs[mocks.capturedSavedGatewayConfigs.length - 1];
    expect(lastSaved?.contextPath).toBe("/gws");
  });

  it("clears saved contextPath when opts do not pass one (retarget scenario)", async () => {
    mocks.ensureNodeHostConfig.mockResolvedValueOnce({
      version: 1,
      nodeId: "node-test",
      gateway: { contextPath: "/old-path" },
    } as any);

    await expect(
      runNodeHost({
        gatewayHost: "192.168.1.1",
        gatewayPort: 9999,
      }),
    ).rejects.toThrow("event loop readiness timeout");

    const lastSaved =
      mocks.capturedSavedGatewayConfigs[mocks.capturedSavedGatewayConfigs.length - 1];
    expect(lastSaved?.contextPath).toBeUndefined();
    expect(lastCapturedOptions()?.url).toBe("ws://192.168.1.1:9999");
  });

  it("clears saved contextPath when explicitly passed as empty string", async () => {
    mocks.ensureNodeHostConfig.mockResolvedValueOnce({
      version: 1,
      nodeId: "node-test",
      gateway: { contextPath: "/old-path" },
    } as any);

    await expect(
      runNodeHost({
        gatewayHost: "127.0.0.1",
        gatewayPort: 18789,
        gatewayContextPath: "",
      }),
    ).rejects.toThrow("event loop readiness timeout");

    const lastSaved =
      mocks.capturedSavedGatewayConfigs[mocks.capturedSavedGatewayConfigs.length - 1];
    expect(lastSaved?.contextPath || undefined).toBeUndefined();
    expect(lastCapturedOptions()?.url).toBe("ws://127.0.0.1:18789");
  });
});
