import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  createConfigHandlerHarness,
  createConfigWriteSnapshot,
  flushConfigHandlerMicrotasks,
} from "./config.test-helpers.js";

const readConfigFileSnapshotForWriteMock = vi.fn();
const writeConfigFileMock = vi.fn();
const validateConfigObjectWithPluginsMock = vi.fn();
const prepareSecretsRuntimeSnapshotMock = vi.fn();
const requestGatewayRestartTransactionMock = vi.fn(async () => ({
  mode: "drain-then-restart",
  restart: {
    scheduled: true,
    delayMs: 1_000,
    coalesced: false,
  },
  transaction: { restartId: "restart-1", state: "restarting" },
  sentinelPath: "/tmp/restart-sentinel.json",
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

vi.mock("../restart-transaction.js", () => ({
  requestGatewayRestartTransaction: requestGatewayRestartTransactionMock,
}));

const { configHandlers } = await import("./config.js");

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
    readConfigFileSnapshotForWriteMock.mockResolvedValue(createConfigWriteSnapshot(prevConfig));

    const { options, disconnectClientsUsingSharedGatewayAuth } = createConfigHandlerHarness({
      method: "config.set",
      params: {
        raw: JSON.stringify(nextConfig, null, 2),
        baseHash: "base-hash",
      },
    });

    await configHandlers["config.set"](options);
    await flushConfigHandlerMicrotasks();

    expect(writeConfigFileMock).toHaveBeenCalledWith(nextConfig, {});
    expect(disconnectClientsUsingSharedGatewayAuth).not.toHaveBeenCalled();
    expect(requestGatewayRestartTransactionMock).not.toHaveBeenCalled();
  });

  it("lets the config reloader own hybrid-mode auth restarts", async () => {
    const prevConfig: OpenClawConfig = {
      gateway: {
        auth: {
          mode: "token",
          token: "old-token",
        },
      },
    };
    readConfigFileSnapshotForWriteMock.mockResolvedValue(createConfigWriteSnapshot(prevConfig));

    const { options, disconnectClientsUsingSharedGatewayAuth } = createConfigHandlerHarness({
      method: "config.patch",
      params: {
        baseHash: "base-hash",
        raw: JSON.stringify({ gateway: { auth: { token: "new-token" } } }),
        restartDelayMs: 1_000,
      },
    });

    await configHandlers["config.patch"](options);
    await flushConfigHandlerMicrotasks();

    expect(requestGatewayRestartTransactionMock).not.toHaveBeenCalled();
    expect(disconnectClientsUsingSharedGatewayAuth).toHaveBeenCalledTimes(1);
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
    readConfigFileSnapshotForWriteMock.mockResolvedValue(createConfigWriteSnapshot(prevConfig));

    const { options, disconnectClientsUsingSharedGatewayAuth } = createConfigHandlerHarness({
      method: "config.patch",
      params: {
        baseHash: "base-hash",
        raw: JSON.stringify({ gateway: { auth: { password: "new-password" } } }),
        restartDelayMs: 1_000,
      },
    });

    await configHandlers["config.patch"](options);
    await flushConfigHandlerMicrotasks();

    expect(requestGatewayRestartTransactionMock).not.toHaveBeenCalled();
    expect(disconnectClientsUsingSharedGatewayAuth).not.toHaveBeenCalled();
  });

  it("still schedules a direct restart for hot mode when the reloader cannot apply the change", async () => {
    const prevConfig: OpenClawConfig = {
      gateway: {
        reload: {
          mode: "hot",
        },
      },
    };
    readConfigFileSnapshotForWriteMock.mockResolvedValue(createConfigWriteSnapshot(prevConfig));

    const { options } = createConfigHandlerHarness({
      method: "config.patch",
      params: {
        baseHash: "base-hash",
        raw: JSON.stringify({ gateway: { port: 19001 } }),
        restartDelayMs: 1_000,
      },
    });

    await configHandlers["config.patch"](options);
    await flushConfigHandlerMicrotasks();

    expect(requestGatewayRestartTransactionMock).toHaveBeenCalledTimes(1);
  });
});
