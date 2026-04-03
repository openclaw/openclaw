import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

const readConfigFileSnapshotForWriteMock = vi.fn();
const writeConfigFileMock = vi.fn();
const validateConfigObjectWithPluginsMock = vi.fn();
const prepareSecretsRuntimeSnapshotMock = vi.fn();
const scheduleGatewaySigusr1RestartMock = vi.fn(() => ({
  scheduled: true,
  delayMs: 1_000,
  coalesced: false,
}));

vi.mock("../../config/config.js", async () => {
  const actual =
    await vi.importActual<typeof import("../../config/config.js")>("../../config/config.js");
  return {
    ...actual,
    createConfigIO: () => ({ configPath: "/tmp/openclaw.json" }),
    readConfigFileSnapshotForWrite: readConfigFileSnapshotForWriteMock,
    validateConfigObjectWithPlugins: validateConfigObjectWithPluginsMock,
    writeConfigFile: writeConfigFileMock,
  };
});

vi.mock("../../config/runtime-schema.js", () => ({
  loadGatewayRuntimeConfigSchema: () => ({ uiHints: undefined }),
}));

vi.mock("../../secrets/runtime.js", () => ({
  prepareSecretsRuntimeSnapshot: prepareSecretsRuntimeSnapshotMock,
}));

vi.mock("../../infra/restart.js", () => ({
  scheduleGatewaySigusr1Restart: scheduleGatewaySigusr1RestartMock,
}));

const { configHandlers } = await import("./config.js");

function createConfigSnapshot(config: OpenClawConfig) {
  return {
    snapshot: {
      path: "/tmp/openclaw.json",
      exists: true,
      raw: JSON.stringify(config, null, 2),
      parsed: config,
      sourceConfig: config,
      resolved: config,
      valid: true,
      runtimeConfig: config,
      config,
      hash: "base-hash",
      issues: [],
      warnings: [],
      legacyIssues: [],
    },
    writeOptions: {} as Record<string, never>,
  };
}

function createOptions(
  params: unknown,
  contextOverrides?: Partial<GatewayRequestHandlerOptions["context"]>,
): GatewayRequestHandlerOptions {
  return {
    req: { type: "req", id: "1", method: "config.patch" },
    params,
    client: null,
    isWebchatConnect: () => false,
    respond: vi.fn(),
    context: {
      logGateway: {
        error: vi.fn(),
        warn: vi.fn(),
        info: vi.fn(),
        debug: vi.fn(),
      },
      disconnectClientsUsingSharedGatewayAuth: vi.fn(),
      ...contextOverrides,
    },
  } as unknown as GatewayRequestHandlerOptions;
}

async function flushMicrotaskQueue() {
  await new Promise<void>((resolve) => queueMicrotask(resolve));
}

afterEach(() => {
  vi.clearAllMocks();
});

beforeEach(() => {
  validateConfigObjectWithPluginsMock.mockImplementation((config: OpenClawConfig) => ({
    ok: true,
    config,
  }));
  prepareSecretsRuntimeSnapshotMock.mockResolvedValue(undefined);
});

describe("config shared auth disconnects", () => {
  it("does not disconnect shared-auth clients for config.set auth writes without restart", async () => {
    const prevConfig: OpenClawConfig = {
      gateway: {
        auth: {
          mode: "token",
          token: "old-token",
        },
      },
    };
    const nextConfig: OpenClawConfig = {
      gateway: {
        auth: {
          mode: "token",
          token: "new-token",
        },
      },
    };
    readConfigFileSnapshotForWriteMock.mockResolvedValue(createConfigSnapshot(prevConfig));

    const opts = createOptions({
      raw: JSON.stringify(nextConfig, null, 2),
      baseHash: "base-hash",
    });

    await configHandlers["config.set"](opts);
    await flushMicrotaskQueue();

    expect(writeConfigFileMock).toHaveBeenCalledWith(nextConfig, {});
    expect(opts.context.disconnectClientsUsingSharedGatewayAuth).not.toHaveBeenCalled();
    expect(scheduleGatewaySigusr1RestartMock).not.toHaveBeenCalled();
  });

  it("disconnects shared-auth clients after config.patch rotates the active token", async () => {
    const prevConfig: OpenClawConfig = {
      gateway: {
        auth: {
          mode: "token",
          token: "old-token",
        },
      },
    };
    readConfigFileSnapshotForWriteMock.mockResolvedValue(createConfigSnapshot(prevConfig));

    const opts = createOptions({
      baseHash: "base-hash",
      raw: JSON.stringify({ gateway: { auth: { token: "new-token" } } }),
      restartDelayMs: 1_000,
    });

    await configHandlers["config.patch"](opts);
    await flushMicrotaskQueue();

    expect(scheduleGatewaySigusr1RestartMock).toHaveBeenCalledTimes(1);
    expect(opts.context.disconnectClientsUsingSharedGatewayAuth).toHaveBeenCalledTimes(1);
  });

  it("does not disconnect shared-auth clients when config.patch changes only inactive password auth", async () => {
    const prevConfig: OpenClawConfig = {
      gateway: {
        auth: {
          mode: "token",
          token: "old-token",
        },
      },
    };
    readConfigFileSnapshotForWriteMock.mockResolvedValue(createConfigSnapshot(prevConfig));

    const opts = createOptions({
      baseHash: "base-hash",
      raw: JSON.stringify({ gateway: { auth: { password: "new-password" } } }),
      restartDelayMs: 1_000,
    });

    await configHandlers["config.patch"](opts);
    await flushMicrotaskQueue();

    expect(scheduleGatewaySigusr1RestartMock).toHaveBeenCalledTimes(1);
    expect(opts.context.disconnectClientsUsingSharedGatewayAuth).not.toHaveBeenCalled();
  });
});
