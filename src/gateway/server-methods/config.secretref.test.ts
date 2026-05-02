import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createConfigHandlerHarness, createConfigWriteSnapshot } from "./config.test-helpers.js";

const readConfigFileSnapshotForWriteMock = vi.fn();
const writeConfigFileMock = vi.fn();
const validateConfigObjectRawWithPluginsMock = vi.fn();
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
    validateConfigObjectRawWithPlugins: validateConfigObjectRawWithPluginsMock,
    validateConfigObjectWithPlugins: validateConfigObjectWithPluginsMock,
    writeConfigFile: writeConfigFileMock,
  };
});

vi.mock("../../config/runtime-schema.js", () => ({
  loadGatewayRuntimeConfigSchema: () => ({ uiHints: undefined }),
}));

vi.mock("../../config/materialize.js", () => ({
  materializeRuntimeConfig: (config: OpenClawConfig) => config,
}));

vi.mock("../../config/merge-patch.js", () => ({
  applyMergePatch: (_base: unknown, patch: unknown) => structuredClone((patch ?? {}) as object),
  createMergePatch: (_prev: unknown, next: unknown) => structuredClone((next ?? {}) as object),
}));

vi.mock("../../secrets/runtime.js", () => ({
  prepareSecretsRuntimeSnapshot: prepareSecretsRuntimeSnapshotMock,
}));

vi.mock("../../infra/restart.js", () => ({
  scheduleGatewaySigusr1Restart: scheduleGatewaySigusr1RestartMock,
}));

const { configHandlers } = await import("./config.js");

afterEach(() => {
  vi.clearAllMocks();
});

beforeEach(() => {
  validateConfigObjectRawWithPluginsMock.mockImplementation((config: OpenClawConfig) => ({
    ok: true,
    config,
  }));
  validateConfigObjectWithPluginsMock.mockImplementation((config: OpenClawConfig) => ({
    ok: true,
    config,
  }));
  prepareSecretsRuntimeSnapshotMock.mockRejectedValue(new Error("Environment variable missing"));
});

describe("config SecretRef rejection", () => {
  it("rejects config.set when request-time SecretRef resolution fails", async () => {
    const nextConfig: OpenClawConfig = {
      gateway: {
        auth: {
          mode: "token",
          token: "new-token",
        },
      },
    };
    readConfigFileSnapshotForWriteMock.mockResolvedValue(createConfigWriteSnapshot({}));

    const { options, respond, disconnectClientsUsingSharedGatewayAuth } =
      createConfigHandlerHarness({
        method: "config.set",
        params: {
          raw: JSON.stringify(nextConfig, null, 2),
          baseHash: "base-hash",
        },
      });

    await configHandlers["config.set"](options);

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: "INVALID_REQUEST",
        message: expect.stringContaining("active SecretRef resolution failed"),
      }),
    );
    expect(writeConfigFileMock).not.toHaveBeenCalled();
    expect(scheduleGatewaySigusr1RestartMock).not.toHaveBeenCalled();
    expect(disconnectClientsUsingSharedGatewayAuth).not.toHaveBeenCalled();
  });

  it("rejects config.patch when request-time SecretRef resolution fails", async () => {
    readConfigFileSnapshotForWriteMock.mockResolvedValue(createConfigWriteSnapshot({}));

    const { options, respond, disconnectClientsUsingSharedGatewayAuth } =
      createConfigHandlerHarness({
        method: "config.patch",
        params: {
          baseHash: "base-hash",
          raw: JSON.stringify({}),
        },
      });

    await configHandlers["config.patch"](options);

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: "INVALID_REQUEST",
        message: expect.stringContaining("active SecretRef resolution failed"),
      }),
    );
    expect(writeConfigFileMock).not.toHaveBeenCalled();
    expect(scheduleGatewaySigusr1RestartMock).not.toHaveBeenCalled();
    expect(disconnectClientsUsingSharedGatewayAuth).not.toHaveBeenCalled();
  });
});
