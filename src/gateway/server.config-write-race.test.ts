import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ConfigFileSnapshot } from "../config/types.js";

const mockReadConfigFileSnapshotForWrite = vi.hoisted(() => vi.fn());
const mockWriteConfigFile = vi.hoisted(() => vi.fn());
const mockLoadConfig = vi.hoisted(() => vi.fn(() => ({})));

vi.mock("../config/config.js", async () => {
  const actual = await vi.importActual<typeof import("../config/config.js")>("../config/config.js");
  return {
    ...actual,
    createConfigIO: vi.fn(() => ({ configPath: "/tmp/openclaw.json" })),
    loadConfig: () => mockLoadConfig(),
    readConfigFileSnapshotForWrite: (...args: unknown[]) =>
      mockReadConfigFileSnapshotForWrite(...args),
    writeConfigFile: (...args: unknown[]) => mockWriteConfigFile(...args),
  };
});

vi.mock("../config/schema.js", async () => {
  const actual = await vi.importActual<typeof import("../config/schema.js")>("../config/schema.js");
  return {
    ...actual,
    buildConfigSchema: vi.fn(() => ({ uiHints: {} })),
    lookupConfigSchema: actual.lookupConfigSchema,
  };
});

vi.mock("../channels/plugins/index.js", () => ({
  listChannelPlugins: vi.fn(() => []),
}));

vi.mock("../plugins/loader.js", () => ({
  loadOpenClawPlugins: vi.fn(() => ({ plugins: [] })),
}));

vi.mock("../config/redact-snapshot.js", async () => {
  const actual = await vi.importActual<typeof import("../config/redact-snapshot.js")>(
    "../config/redact-snapshot.js",
  );
  return {
    ...actual,
    restoreRedactedValues: vi.fn((value: unknown) => ({ ok: true, result: value })),
    redactConfigObject: actual.redactConfigObject,
    redactConfigSnapshot: actual.redactConfigSnapshot,
  };
});

vi.mock("../config/legacy.js", () => ({
  applyLegacyMigrations: vi.fn((value: unknown) => ({ next: value })),
}));

vi.mock("../config/validation.js", async () => {
  const actual =
    await vi.importActual<typeof import("../config/validation.js")>("../config/validation.js");
  return {
    ...actual,
    validateConfigObjectWithPlugins: vi.fn((value: unknown) => ({ ok: true, config: value })),
  };
});

vi.mock("../infra/restart.js", () => ({
  scheduleGatewaySigusr1Restart: vi.fn(() => ({ coalesced: false, delayMs: 2000, reason: "test" })),
}));

vi.mock("../config/sessions.js", async () => {
  const actual =
    await vi.importActual<typeof import("../config/sessions.js")>("../config/sessions.js");
  return {
    ...actual,
    extractDeliveryInfo: vi.fn(() => ({ deliveryContext: undefined, threadId: undefined })),
  };
});

vi.mock("../control-plane-audit.js", async () => {
  const actual = await vi.importActual<typeof import("../control-plane-audit.js")>(
    "../control-plane-audit.js",
  );
  return {
    ...actual,
    resolveControlPlaneActor: vi.fn(() => ({
      actor: "test",
      deviceId: null,
      clientIp: null,
    })),
    formatControlPlaneActor: vi.fn(() => "test"),
    summarizeChangedPaths: vi.fn(() => "gateway.auth, channels.telegram"),
  };
});

import { configHandlers } from "./server-methods/config.js";

function makeSnapshot(params: {
  hash: string;
  config: Record<string, unknown>;
}): ConfigFileSnapshot {
  return {
    path: "/tmp/openclaw.json",
    exists: true,
    raw: JSON.stringify(params.config),
    parsed: params.config,
    resolved: params.config,
    valid: true,
    config: params.config,
    hash: params.hash,
    issues: [],
    warnings: [],
    legacyIssues: [],
  };
}

describe("config write race", () => {
  beforeEach(() => {
    mockReadConfigFileSnapshotForWrite.mockReset();
    mockWriteConfigFile.mockReset();
    mockLoadConfig.mockReset();
    mockLoadConfig.mockReturnValue({});
  });

  it("serializes config.patch so stale concurrent writes are rejected", async () => {
    let firstWriteDone = false;
    let releaseFirstWrite!: () => void;
    const firstWriteBlocked = new Promise<void>((resolve) => {
      releaseFirstWrite = resolve;
    });

    mockReadConfigFileSnapshotForWrite.mockImplementation(async () => {
      return firstWriteDone
        ? {
            snapshot: makeSnapshot({
              hash: "hash-2",
              config: {
                gateway: { mode: "local" },
              },
            }),
            writeOptions: {},
          }
        : {
            snapshot: makeSnapshot({
              hash: "hash-1",
              config: {
                gateway: { mode: "local" },
                channels: { telegram: { token: "one" } },
              },
            }),
            writeOptions: {},
          };
    });

    mockWriteConfigFile.mockImplementationOnce(async () => {
      await firstWriteBlocked;
      firstWriteDone = true;
    });

    const firstRespond = vi.fn();
    const secondRespond = vi.fn();
    const context = {
      logGateway: {
        info: vi.fn(),
        warn: vi.fn(),
      },
    };

    const firstCall = configHandlers["config.patch"]({
      params: {
        raw: JSON.stringify({
          channels: {
            telegram: null,
          },
        }),
        baseHash: "hash-1",
      },
      respond: firstRespond,
      client: undefined,
      context,
      req: undefined,
    } as never);

    await vi.waitFor(() => {
      expect(mockWriteConfigFile).toHaveBeenCalledTimes(1);
    });

    const secondCall = configHandlers["config.patch"]({
      params: {
        raw: JSON.stringify({
          gateway: {
            auth: { mode: "token", token: "two" },
          },
        }),
        baseHash: "hash-1",
      },
      respond: secondRespond,
      client: undefined,
      context,
      req: undefined,
    } as never);

    releaseFirstWrite();
    await Promise.all([firstCall, secondCall]);

    expect(firstRespond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ ok: true }),
      undefined,
    );
    expect(secondRespond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        message: "config changed since last load; re-run config.get and retry",
      }),
    );
    expect(mockReadConfigFileSnapshotForWrite).toHaveBeenCalledTimes(2);
  });

  it("serializes config.apply so stale concurrent writes are rejected", async () => {
    let firstWriteDone = false;
    let releaseFirstWrite!: () => void;
    const firstWriteBlocked = new Promise<void>((resolve) => {
      releaseFirstWrite = resolve;
    });

    mockReadConfigFileSnapshotForWrite.mockImplementation(async () => {
      return firstWriteDone
        ? {
            snapshot: makeSnapshot({
              hash: "hash-2",
              config: {
                gateway: { mode: "local" },
                features: { alpha: true },
              },
            }),
            writeOptions: {},
          }
        : {
            snapshot: makeSnapshot({
              hash: "hash-1",
              config: {
                gateway: { mode: "local" },
                features: { alpha: false },
              },
            }),
            writeOptions: {},
          };
    });

    mockWriteConfigFile.mockImplementationOnce(async () => {
      await firstWriteBlocked;
      firstWriteDone = true;
    });

    const firstRespond = vi.fn();
    const secondRespond = vi.fn();
    const context = {
      logGateway: {
        info: vi.fn(),
        warn: vi.fn(),
      },
    };

    const firstCall = configHandlers["config.apply"]({
      params: {
        raw: JSON.stringify({
          gateway: { mode: "local" },
          features: { alpha: true },
        }),
        baseHash: "hash-1",
      },
      respond: firstRespond,
      client: undefined,
      context,
      req: undefined,
    } as never);

    await vi.waitFor(() => {
      expect(mockWriteConfigFile).toHaveBeenCalledTimes(1);
    });

    const secondCall = configHandlers["config.apply"]({
      params: {
        raw: JSON.stringify({
          gateway: { mode: "local" },
          features: { beta: true },
        }),
        baseHash: "hash-1",
      },
      respond: secondRespond,
      client: undefined,
      context,
      req: undefined,
    } as never);

    releaseFirstWrite();
    await Promise.all([firstCall, secondCall]);

    expect(firstRespond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ ok: true }),
      undefined,
    );
    expect(secondRespond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        message: "config changed since last load; re-run config.get and retry",
      }),
    );
    expect(mockReadConfigFileSnapshotForWrite).toHaveBeenCalledTimes(2);
  });
});
