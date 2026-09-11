import { beforeEach, describe, expect, it, vi } from "vitest";
import { getRuntimeConfigWriteApplication } from "../../config/runtime-write-application.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { RestartSentinelPayload } from "../../infra/restart-sentinel.js";

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
const restartSentinelMocks = vi.hoisted(() => ({
  writeRestartSentinel: vi.fn(async (_payload: RestartSentinelPayload) => undefined),
}));
const restartMocks = vi.hoisted(() => ({
  scheduleGatewaySigusr1Restart: vi.fn(() => ({
    scheduled: true,
    delayMs: 1_000,
    coalesced: false,
  })),
}));

vi.mock("../../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../config/config.js")>();
  return {
    ...actual,
    replaceConfigFile: configMocks.replaceConfigFile,
    resolveConfigSnapshotHash: configMocks.resolveConfigSnapshotHash,
  };
});

vi.mock("../../secrets/runtime-state.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../secrets/runtime-state.js")>();
  return {
    ...actual,
    getActiveSecretsRuntimeSnapshotState: () => secretsMocks.activeSnapshot,
  };
});

vi.mock("../../infra/restart-sentinel.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../infra/restart-sentinel.js")>();
  return {
    ...actual,
    writeRestartSentinel: restartSentinelMocks.writeRestartSentinel,
  };
});

vi.mock("../../infra/restart.js", () => ({
  scheduleGatewaySigusr1Restart: restartMocks.scheduleGatewaySigusr1Restart,
}));

import {
  commitGatewayConfigWrite,
  didActiveSharedGatewayAuthChange,
  resolveGatewayConfigRestartWriteResult,
  shouldAwaitGatewayConfigApplication,
} from "./config-write-flow.js";

it("awaits title application only with authoritative identity and an enabled reload owner", () => {
  const previousConfig: OpenClawConfig = {
    transcripts: { autoStart: [{ providerId: "fixture", sessionId: "daily", title: "Before" }] },
  };
  const nextConfig: OpenClawConfig = {
    transcripts: { autoStart: [{ providerId: "fixture", sessionId: "daily", title: "After" }] },
  };
  const params = { previousConfig, nextConfig, changedPaths: ["transcripts.autoStart"] };
  expect(shouldAwaitGatewayConfigApplication(params)).toBe(true);
  expect(shouldAwaitGatewayConfigApplication({ ...params, previousConfig: {} })).toBe(false);
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

describe("resolveGatewayConfigRestartWriteResult", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does not persist a restart sentinel for a hot-applied write", async () => {
    // agents.defaults.model is hot-applied; no gateway restart is required.
    const previousConfig: OpenClawConfig = { agents: { defaults: { model: "old-model" } } };
    const nextConfig: OpenClawConfig = { agents: { defaults: { model: "new-model" } } };

    const result = await resolveGatewayConfigRestartWriteResult({
      requestParams: {},
      kind: "config-patch",
      mode: "config.patch",
      configPath: "/tmp/openclaw.json",
      changedPaths: ["agents.defaults.model"],
      previousConfig,
      nextConfig,
      actor: {
        actor: "openclaw-control-ui",
        deviceId: "device-1",
        clientIp: "127.0.0.1",
        connId: "conn-1",
      },
    });

    expect(result.sentinelPersisted).toBe(false);
    expect(result.restart).toBeUndefined();
    expect(restartSentinelMocks.writeRestartSentinel).not.toHaveBeenCalled();
    expect(restartMocks.scheduleGatewaySigusr1Restart).not.toHaveBeenCalled();
    expect(result.payload.stats?.requiresRestart).toBe(false);
    // A hot-applied write carries no doctor hint: there is no restart to follow
    // up on, and doctor --non-interactive has write semantics (#144063).
    expect(result.payload.doctorHint).toBeNull();
  });

  it("persists a restart sentinel with a doctor hint for a restart-requiring write", async () => {
    // gateway.port requires a gateway restart.
    const previousConfig: OpenClawConfig = { gateway: { port: 4_000 } };
    const nextConfig: OpenClawConfig = { gateway: { port: 4_001 } };

    const result = await resolveGatewayConfigRestartWriteResult({
      requestParams: {},
      kind: "config-patch",
      mode: "config.patch",
      configPath: "/tmp/openclaw.json",
      changedPaths: ["gateway.port"],
      previousConfig,
      nextConfig,
      actor: {
        actor: "openclaw-control-ui",
        deviceId: "device-1",
        clientIp: "127.0.0.1",
        connId: "conn-1",
      },
    });

    expect(result.sentinelPersisted).toBe(true);
    expect(restartSentinelMocks.writeRestartSentinel).toHaveBeenCalledOnce();
    expect(result.payload.stats?.requiresRestart).toBe(true);
    expect(result.payload.doctorHint).not.toBeNull();
    expect(result.payload.doctorHint).toContain("openclaw doctor --non-interactive");
  });
});
