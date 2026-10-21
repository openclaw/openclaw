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
  writeRestartSentinel: vi.fn(async (_payload: RestartSentinelPayload) => ({
    version: 1 as const,
    payload: _payload,
    revision: 1,
  })),
}));
const restartMocks = vi.hoisted(() => ({
  scheduleGatewayRestart: vi.fn(() => ({
    ok: true,
    pid: process.pid,
    signal: "SIGUSR2",
    delayMs: 1_000,
    reason: "config.patch",
    mode: "emit",
    coalesced: false,
    cooldownMsApplied: 0,
    emitHooksQueued: false,
  })),
}));

vi.mock("../../config/config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../config/config.js")>()),
  replaceConfigFile: configMocks.replaceConfigFile,
  resolveConfigSnapshotHash: configMocks.resolveConfigSnapshotHash,
}));

vi.mock("../../secrets/runtime-state.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../secrets/runtime-state.js")>()),
  getActiveSecretsRuntimeSnapshotState: () => secretsMocks.activeSnapshot,
}));

vi.mock("../../infra/restart-sentinel.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/restart-sentinel.js")>()),
  writeRestartSentinel: restartSentinelMocks.writeRestartSentinel,
}));

// mock-isolation: Gateway restart scheduling is process-global; tests verify the write result without triggering a real restart.
vi.mock("../../infra/restart.js", () => ({
  scheduleGatewayRestart: restartMocks.scheduleGatewayRestart,
}));

import {
  commitGatewayConfigWrite,
  didActiveSharedGatewayAuthChange,
  resolveGatewayConfigRestartWriteResult,
  shouldAwaitGatewayConfigApplication,
} from "./config-write-flow.js";

const authConfig = (
  token?: NonNullable<NonNullable<OpenClawConfig["gateway"]>["auth"]>["token"],
): OpenClawConfig => ({
  gateway: { auth: { mode: "token", ...(token === undefined ? {} : { token }) } },
});
const runtimeConfig = authConfig("runtime-token");
const authoredConfig = authConfig();
const hookConfig: OpenClawConfig = { hooks: { enabled: true } };
const writeSnapshot = (exists = true) => ({
  path: "/tmp/openclaw.json",
  exists,
  raw: exists ? "{}" : null,
  hash: exists ? "base-hash" : "missing-config-revision",
});
const commit = (exists = true) =>
  commitGatewayConfigWrite({
    snapshot: writeSnapshot(exists) as never,
    writeOptions: {},
    nextConfig: exists ? hookConfig : {},
    ...(exists ? { awaitRuntimeApplication: true } : {}),
  });
const restartWriteActor = {
  actor: "openclaw-control-ui",
  deviceId: "device-1",
  clientIp: "127.0.0.1",
  connId: "conn-1",
} as const;
const resolveRestartWrite = (
  changedPaths: string[],
  previousConfig: OpenClawConfig,
  nextConfig: OpenClawConfig,
) =>
  resolveGatewayConfigRestartWriteResult({
    requestParams: {},
    kind: "config-patch",
    mode: "config.patch",
    configPath: "/tmp/openclaw.json",
    changedPaths,
    previousConfig,
    nextConfig,
    actor: restartWriteActor,
  });

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

it.each(["hybrid", "off"] as const)(
  "hot-applies cold-storage settings with reload mode %s",
  (mode) => {
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
    ).toBe(true);
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
    await commit(false);
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
      return { nextConfig: hookConfig, persistedHash: "persisted-hash" };
    });
    const result = await commit();
    await expect(result.application).resolves.toBe("applied");
  });

  it("returns an unclaimed required application when no managed reloader is installed", async () => {
    const result = await commit();
    await expect(result.application).resolves.toBe("unclaimed");
  });
});

const tokenA = authConfig("token-a");
const tokenB = authConfig("token-b");
const secretRef = authConfig({ source: "env", provider: "default", id: "GATEWAY_TOKEN" });
it.each([
  ["runtime-only fields", {}, {}, runtimeConfig, runtimeConfig, undefined, false],
  ["stale authored source", tokenA, tokenA, tokenB, tokenA, tokenB, true],
  [
    "runtime-only siblings",
    authoredConfig,
    authoredConfig,
    runtimeConfig,
    runtimeConfig,
    authoredConfig,
    false,
  ],
  [
    "matching secret source",
    secretRef,
    authConfig("old-token"),
    secretRef,
    authConfig("new-token"),
    secretRef,
    true,
  ],
] as const)(
  "compares shared auth with %s",
  (_name, sourceConfig, config, fallbackPrev, next, fallbackSource, expected) => {
    secretsMocks.activeSnapshot = { sourceConfig, config };
    expect(didActiveSharedGatewayAuthChange({ fallbackPrev, next, fallbackSource })).toBe(expected);
  },
);

describe("resolveGatewayConfigRestartWriteResult", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does not persist a restart sentinel for a hot-applied write", async () => {
    const result = await resolveRestartWrite(
      ["agents.defaults.model"],
      { agents: { defaults: { model: "old-model" } } },
      { agents: { defaults: { model: "new-model" } } },
    );

    expect(result.sentinelPersisted).toBe(false);
    expect(result.restart).toBeUndefined();
    expect(restartSentinelMocks.writeRestartSentinel).not.toHaveBeenCalled();
    expect(restartMocks.scheduleGatewayRestart).not.toHaveBeenCalled();
    expect(result.payload.stats?.requiresRestart).toBe(false);
    expect(result.payload.doctorHint).toBeNull();
  });

  it("persists a restart sentinel with a doctor hint for a restart-requiring write", async () => {
    const result = await resolveRestartWrite(
      ["gateway.port"],
      { gateway: { port: 4_000 } },
      { gateway: { port: 4_001 } },
    );

    expect(result.sentinelPersisted).toBe(true);
    expect(restartSentinelMocks.writeRestartSentinel).toHaveBeenCalledOnce();
    expect(result.payload.stats?.requiresRestart).toBe(true);
    expect(result.payload.doctorHint).not.toBeNull();
    expect(result.payload.doctorHint).toContain("openclaw doctor --non-interactive");
  });
});
