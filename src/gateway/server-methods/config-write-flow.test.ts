import { beforeEach, describe, expect, it, vi } from "vitest";
import { getRuntimeConfigWriteApplication } from "../../config/runtime-write-application.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";

const configMocks = vi.hoisted(() => ({
  replaceConfigFile: vi.fn(),
  resolveConfigSnapshotHash: vi.fn(),
}));
const secretsMocks = vi.hoisted(() => ({
  activeSnapshot: null as {
    sourceConfig: OpenClawConfig;
    config: OpenClawConfig;
  } | null,
}));

vi.mock("../../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../config/config.js")>();
  return {
    ...actual,
    replaceConfigFile: configMocks.replaceConfigFile,
    resolveConfigSnapshotHash: configMocks.resolveConfigSnapshotHash,
  };
});

const restartMocks = vi.hoisted(() => ({
  scheduleGatewayRestart: vi.fn(() => ({ ok: true, delayMs: 0 })),
}));

vi.mock("../../infra/restart.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/restart.js")>()),
  scheduleGatewayRestart: restartMocks.scheduleGatewayRestart,
}));

vi.mock("../../infra/restart-sentinel.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/restart-sentinel.js")>()),
  writeRestartSentinel: vi.fn(async () => {}),
}));

vi.mock("../../secrets/runtime-state.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../secrets/runtime-state.js")>();
  return {
    ...actual,
    getActiveSecretsRuntimeSnapshotState: () => secretsMocks.activeSnapshot,
  };
});

import {
  commitGatewayConfigWrite,
  didActiveSharedGatewayAuthChange,
  resolveGatewayConfigRestartWriteResult,
  shouldAwaitGatewayConfigApplication,
} from "./config-write-flow.js";

it("awaits transcript additions and title edits only when the reload owner can apply them", () => {
  const previousConfig: OpenClawConfig = {
    transcripts: { autoStart: [{ providerId: "fixture", sessionId: "daily", title: "Before" }] },
  };
  const nextConfig: OpenClawConfig = {
    transcripts: { autoStart: [{ providerId: "fixture", sessionId: "daily", title: "After" }] },
  };
  const params = { previousConfig, nextConfig, changedPaths: ["transcripts.autoStart"] };
  expect(shouldAwaitGatewayConfigApplication(params)).toBe(true);
  expect(shouldAwaitGatewayConfigApplication({ ...params, previousConfig: {} })).toBe(true);
  expect(
    shouldAwaitGatewayConfigApplication({
      ...params,
      changedPaths: [...params.changedPaths, "gateway.port"],
    }),
  ).toBe(false);
  expect(
    shouldAwaitGatewayConfigApplication({
      ...params,
      nextConfig: { ...nextConfig, gateway: { reload: { mode: "off" } } },
    }),
  ).toBe(false);
});

it.each([
  ["hybrid", true],
  ["off", false],
] as const)(
  "awaits cold-storage settings only when reload mode %s can apply them",
  (mode, awaited) => {
    expect(
      shouldAwaitGatewayConfigApplication({
        previousConfig: {},
        nextConfig: {
          gateway: { reload: { mode } },
          session: { maintenance: { coldStorage: { enabled: true, afterDays: 7 } } },
        },
        changedPaths: [
          "session.maintenance.coldStorage.enabled",
          "session.maintenance.coldStorage.afterDays",
        ],
      }),
    ).toBe(awaited);
  },
);

it.each([
  { mode: "off", path: "gateway.nodes.commands.allow", cli: false, restart: true },
  { mode: "off", path: "gateway.nodes.commands.allow", cli: true, restart: false },
  { mode: "hybrid", path: "gateway.port", cli: true, restart: false },
  { mode: "restart", path: "gateway.port", cli: true, restart: false },
] as const)(
  "schedules a direct restart for $path under reload $mode (CLI caller: $cli): $restart",
  async ({ mode, path, cli, restart }) => {
    restartMocks.scheduleGatewayRestart.mockClear();
    const result = await resolveGatewayConfigRestartWriteResult({
      requestParams: {},
      kind: "config-patch",
      mode: "config.patch",
      configPath: "/tmp/openclaw.json",
      changedPaths: [path],
      previousConfig: { gateway: { reload: { mode } } },
      nextConfig: { gateway: { reload: { mode }, port: 19001 } },
      client: {
        connect: {
          client: cli ? { id: "cli", mode: "cli" } : { id: "openclaw-control-ui", mode: "webchat" },
        },
      } as never,
    });
    // Hybrid and restart modes leave restart-required changes to the config reloader.
    expect(result.payload.stats?.requiresRestart).toBe(true);
    expect(result.restart !== undefined).toBe(restart);
    expect(restartMocks.scheduleGatewayRestart).toHaveBeenCalledTimes(restart ? 1 : 0);
  },
);

describe("commitGatewayConfigWrite", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    configMocks.resolveConfigSnapshotHash.mockReturnValue("missing-config-revision");
    configMocks.replaceConfigFile.mockResolvedValue({
      nextConfig: {},
      persistedHash: "persisted-hash",
    });
    secretsMocks.activeSnapshot = null;
  });

  it("carries a missing file revision into the lock-time compare-and-swap", async () => {
    const snapshot = {
      path: "/tmp/openclaw.json",
      exists: false,
      raw: null,
      hash: "missing-config-revision",
    };

    await commitGatewayConfigWrite({
      snapshot: snapshot as never,
      writeOptions: {},
      nextConfig: {} satisfies OpenClawConfig,
    });

    expect(configMocks.replaceConfigFile).toHaveBeenCalledWith(
      expect.objectContaining({
        baseHash: "missing-config-revision",
        sourceConfig: {},
      }),
    );
  });

  it("returns the managed runtime application claimed during the write", async () => {
    configMocks.replaceConfigFile.mockImplementationOnce(async (params) => {
      const application = getRuntimeConfigWriteApplication(params.writeOptions);
      const claim = application?.claim();
      claim?.settle("applied");
      return {
        nextConfig: { hooks: { enabled: true } },
        persistedHash: "persisted-hash",
      };
    });

    const result = await commitGatewayConfigWrite({
      snapshot: {
        path: "/tmp/openclaw.json",
        exists: true,
        raw: "{}",
        hash: "base-hash",
      } as never,
      writeOptions: {},
      nextConfig: { hooks: { enabled: true } },
      awaitRuntimeApplication: true,
    });

    await expect(result.application).resolves.toBe("applied");
  });

  it("returns an unclaimed required application when no managed reloader is installed", async () => {
    const result = await commitGatewayConfigWrite({
      snapshot: {
        path: "/tmp/openclaw.json",
        exists: true,
        raw: "{}",
        hash: "base-hash",
      } as never,
      writeOptions: {},
      nextConfig: { hooks: { enabled: true } },
      awaitRuntimeApplication: true,
    });

    await expect(result.application).resolves.toBe("unclaimed");
  });
});

describe("didActiveSharedGatewayAuthChange", () => {
  beforeEach(() => {
    secretsMocks.activeSnapshot = null;
  });

  it("preserves runtime-only auth fields absent from the active secrets source", () => {
    const runtimeConfig: OpenClawConfig = {
      gateway: { auth: { mode: "token", token: "runtime-token" } },
    };
    secretsMocks.activeSnapshot = {
      sourceConfig: {},
      config: {},
    };

    expect(
      didActiveSharedGatewayAuthChange({ fallbackPrev: runtimeConfig, next: runtimeConfig }),
    ).toBe(false);
  });

  it("does not trust active secret values from a stale authored source", () => {
    secretsMocks.activeSnapshot = {
      sourceConfig: { gateway: { auth: { mode: "token", token: "token-a" } } },
      config: { gateway: { auth: { mode: "token", token: "token-a" } } },
    };
    const current: OpenClawConfig = {
      gateway: { auth: { mode: "token", token: "token-b" } },
    };

    expect(
      didActiveSharedGatewayAuthChange({
        fallbackPrev: current,
        fallbackSource: current,
        next: { gateway: { auth: { mode: "token", token: "token-a" } } },
      }),
    ).toBe(true);
  });

  it("preserves runtime-only siblings beside authored shared auth fields", () => {
    secretsMocks.activeSnapshot = {
      sourceConfig: { gateway: { auth: { mode: "token" } } },
      config: { gateway: { auth: { mode: "token" } } },
    };
    const runtimeConfig: OpenClawConfig = {
      gateway: { auth: { mode: "token", token: "runtime-token" } },
    };

    expect(
      didActiveSharedGatewayAuthChange({
        fallbackPrev: runtimeConfig,
        fallbackSource: { gateway: { auth: { mode: "token" } } },
        next: runtimeConfig,
      }),
    ).toBe(false);
  });

  it("uses active secret-expanded values when the authored source still matches", () => {
    const tokenRef = {
      source: "env" as const,
      provider: "default",
      id: "GATEWAY_TOKEN",
    };
    secretsMocks.activeSnapshot = {
      sourceConfig: { gateway: { auth: { mode: "token", token: tokenRef } } },
      config: { gateway: { auth: { mode: "token", token: "old-token" } } },
    };

    expect(
      didActiveSharedGatewayAuthChange({
        fallbackPrev: { gateway: { auth: { mode: "token", token: tokenRef } } },
        fallbackSource: { gateway: { auth: { mode: "token", token: tokenRef } } },
        next: { gateway: { auth: { mode: "token", token: "new-token" } } },
      }),
    ).toBe(true);
  });
});
