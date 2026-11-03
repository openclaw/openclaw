import { describe, expect, it, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../test/helpers/promise.js";
import { UpdateCampaignController } from "./update-campaign.js";
import { currentUpdateCheckLifecycle } from "./update-check-lifecycle.js";
import type { UpdateCheckResult } from "./update-check.js";
import { listUpdateRuns } from "./update-run-ledger.js";
import { createDevGitStatus } from "./update-startup-git.test-support.js";
import {
  setupUpdateStartupFixture,
  checkTelemetryUpdateMock,
  detectRespawnSupervisorMock,
  scheduleGatewayRestartMock,
  startManagedServiceUpdateHandoffMock,
  versionMock,
  scheduler,
  clock,
  resolveOpenClawPackageRoot,
  checkUpdateStatus,
  resolveNpmChannelTag,
  getUpdateAvailable,
  getUpdateEffectiveChannel,
  getUpdateSchedule,
  resetUpdateAvailableStateForTest,
  runGatewayUpdateCheck,
  readPersistedUpdateCheckState,
  expectLastTelemetryConfig,
  writePersistedUpdateCheckState,
  mockPackageUpdateStatus,
  mockPackageInstallStatus,
  mockNpmChannelTag,
  createAutoUpdateSuccessMock,
  idleActiveWorkInspectors,
  createBetaAutoUpdateConfig,
  createExtendedStableConfig,
  runExtendedStableUpdateCheck,
  seedExtendedStableAvailability,
  seedStableAutoRolloutState,
  expectStableAutoRolloutStatePreserved,
} from "./update-startup-suite.test-support.js";

// Install shared mocks before the production imports, regardless of import sorting.
await vi.hoisted(() => import("./update-startup-suite.test-support.js"));

describe("update-startup", () => {
  setupUpdateStartupFixture();

  it("retries install identity initialization after a failed probe", async () => {
    vi.mocked(resolveOpenClawPackageRoot).mockResolvedValue("/opt/openclaw");
    vi.mocked(checkUpdateStatus).mockRejectedValueOnce(new Error("probe failed"));

    await expect(getUpdateEffectiveChannel()).rejects.toThrow("probe failed");

    mockPackageInstallStatus();
    await expect(getUpdateEffectiveChannel()).resolves.toBe("stable");
    expect(checkUpdateStatus).toHaveBeenCalledTimes(2);
  });

  it("coalesces configless Git identity before the schedule cache is ready", async ({ signal }) => {
    const entered = createDeferred();
    const probe = createDeferred<UpdateCheckResult>();
    const status = createDevGitStatus({ behind: 0, fetchOk: false });
    vi.mocked(resolveOpenClawPackageRoot).mockResolvedValue("/opt/openclaw");
    vi.mocked(checkUpdateStatus).mockImplementationOnce(() => {
      entered.resolve();
      return probe.promise;
    });

    const first = getUpdateEffectiveChannel();
    const second = getUpdateEffectiveChannel();
    const channels = Promise.all([first, second]);
    try {
      await withinTest(
        awaitGateBeforeSettlement(entered.promise, channels, "install discovery did not start"),
        signal,
      );
      expect(checkUpdateStatus).toHaveBeenCalledTimes(1);
      probe.resolve(status);

      await expect(channels).resolves.toEqual(["dev", "dev"]);
      await expect(getUpdateEffectiveChannel()).resolves.toBe("dev");
      expect(checkUpdateStatus).toHaveBeenCalledTimes(1);
    } finally {
      probe.resolve(status);
      await Promise.allSettled([channels]);
    }
  });

  it("appends a bounded, terminal-safe remote note to the automatic update notice", async () => {
    mockPackageInstallStatus();
    checkTelemetryUpdateMock.mockResolvedValue({
      version: "2.0.0",
      note: `\u001b[2KImportant\nnotice ${"x".repeat(600)}`,
    });
    const log = { info: vi.fn() };

    await runGatewayUpdateCheck({
      cfg: {},
      log,
    });

    const message = log.info.mock.calls[0]?.[0];
    expect(message).toContain("Note: Important\\nnotice ");
    expect(message).not.toContain("\u001b");
    expect(message?.split("Note: ")[1]).toHaveLength(500);
    expect(resolveNpmChannelTag).not.toHaveBeenCalled();
  });

  it("does not throttle invalid update-check clocks against persisted state", async () => {
    writePersistedUpdateCheckState({
      lastCheckedAt: "2026-01-17T09:30:00.000Z",
    });
    mockPackageUpdateStatus("latest", "2.0.0");
    vi.spyOn(Date, "now").mockReturnValue(8_640_000_000_000_001);

    await runGatewayUpdateCheck({
      cfg: { update: { channel: "stable" } },
    });

    expect(checkUpdateStatus).toHaveBeenCalledTimes(1);
    const parsed = readPersistedUpdateCheckState();
    expect(parsed?.lastCheckedAt).toBe("1970-01-01T00:00:00.000Z");
    expect(parsed?.lastAvailableVersion).toBe("2.0.0");
  });

  it.each([
    {
      channel: "stable" as const,
      persistedTag: undefined,
      expectedTag: "latest",
    },
    {
      channel: "beta" as const,
      persistedTag: "latest",
      expectedTag: "latest",
    },
  ])(
    "hydrates $channel cached availability from its compatible $expectedTag tag",
    async ({ channel, persistedTag, expectedTag }) => {
      writePersistedUpdateCheckState({
        lastCheckedAt: new Date(Date.now()).toISOString(),
        lastCheckedChannel: channel,
        lastAvailableVersion: "2.0.0",
        lastAvailableTag: persistedTag,
      });
      mockPackageInstallStatus();
      const onUpdateAvailableChange = vi.fn();

      await runGatewayUpdateCheck({
        cfg: { update: { channel } },
        onUpdateAvailableChange,
      });

      expect(checkUpdateStatus).toHaveBeenCalledTimes(1);
      expect(resolveNpmChannelTag).not.toHaveBeenCalled();
      expect(onUpdateAvailableChange).toHaveBeenCalledWith({
        currentVersion: "1.0.0",
        latestVersion: "2.0.0",
        channel: expectedTag,
      });
    },
  );

  it("emits an update change when a previously available version becomes current", async () => {
    mockPackageInstallStatus();
    checkTelemetryUpdateMock
      .mockResolvedValueOnce({ version: "2.0.0" })
      .mockResolvedValueOnce({ version: "1.0.0" });
    const onUpdateAvailableChange = vi.fn();
    const params = { cfg: { update: { channel: "stable" as const } }, onUpdateAvailableChange };
    await runGatewayUpdateCheck(params);
    clock.setTime(Date.parse("2026-01-18T11:00:00Z"));
    await runGatewayUpdateCheck(params);
    expect(onUpdateAvailableChange).toHaveBeenNthCalledWith(1, {
      currentVersion: "1.0.0",
      latestVersion: "2.0.0",
      channel: "latest",
    });
    expect(onUpdateAvailableChange).toHaveBeenNthCalledWith(2, null);
    expect(getUpdateAvailable()).toBeNull();
  });

  it("uses the exact selector for an installed final extended-stable package", async () => {
    versionMock.value = "2026.6.33";
    mockPackageUpdateStatus("extended-stable", "2026.7.33");
    const onUpdateAvailableChange = vi.fn();

    await runGatewayUpdateCheck({
      cfg: {},
      onUpdateAvailableChange,
    });

    expectLastTelemetryConfig({});
    expect(resolveNpmChannelTag).toHaveBeenCalledWith({
      channel: "extended-stable",
    });
    expect(onUpdateAvailableChange).toHaveBeenCalledWith({
      currentVersion: "2026.6.33",
      latestVersion: "2026.7.33",
      channel: "extended-stable",
    });
  });

  it("discovers and deduplicates an exact extended-stable update without auto-applying", async () => {
    const onUpdateAvailableChange = vi.fn();
    const runAutoUpdate = createAutoUpdateSuccessMock();
    mockPackageUpdateStatus("extended-stable", "2.0.0");
    const log = { info: vi.fn() };

    await runExtendedStableUpdateCheck({
      cfg: createExtendedStableConfig({ autoEnabled: true }),
      log,
      onUpdateAvailableChange,
      runAutoUpdate,
    });
    clock.setTime(Date.parse("2026-01-18T11:00:00Z"));
    await runExtendedStableUpdateCheck({
      cfg: createExtendedStableConfig({ autoEnabled: true }),
      log,
      onUpdateAvailableChange,
      runAutoUpdate,
    });

    expect(checkTelemetryUpdateMock).toHaveBeenCalledTimes(2);
    expect(log.info).toHaveBeenCalledTimes(1);
    expect(onUpdateAvailableChange).toHaveBeenCalledTimes(1);
    expect(onUpdateAvailableChange).toHaveBeenCalledWith({
      currentVersion: "1.0.0",
      latestVersion: "2.0.0",
      channel: "extended-stable",
    });
    expect(readPersistedUpdateCheckState()).toMatchObject({
      lastNotifiedVersion: "2.0.0",
      lastNotifiedTag: "extended-stable",
      lastAvailableVersion: "2.0.0",
      lastAvailableTag: "extended-stable",
    });
    expect(runAutoUpdate).not.toHaveBeenCalled();
    expect(startManagedServiceUpdateHandoffMock).not.toHaveBeenCalled();
    expect(scheduleGatewayRestartMock).not.toHaveBeenCalled();
    expect(readPersistedUpdateCheckState()?.autoFirstSeenVersion).toBeUndefined();
  });

  it("clears stale extended-stable availability when exact selector resolution fails", async () => {
    const onUpdateAvailableChange = vi.fn();
    await seedExtendedStableAvailability({ onUpdateAvailableChange });
    seedStableAutoRolloutState();
    onUpdateAvailableChange.mockClear();
    vi.mocked(resolveNpmChannelTag).mockResolvedValue({ tag: "extended-stable", version: null });
    clock.setTime(Date.parse("2026-01-18T11:00:00Z"));
    const log = { info: vi.fn() };

    await runExtendedStableUpdateCheck({ log, onUpdateAvailableChange });

    expect(log.info).not.toHaveBeenCalled();
    expect(onUpdateAvailableChange).toHaveBeenCalledOnce();
    expect(onUpdateAvailableChange).toHaveBeenCalledWith(null);
    expect(getUpdateAvailable()).toBeNull();
    expect(readPersistedUpdateCheckState()?.lastAvailableVersion).toBeUndefined();
    expect(readPersistedUpdateCheckState()?.lastCheckedChannel).toBe("extended-stable");
    expectStableAutoRolloutStatePreserved();
    expect(startManagedServiceUpdateHandoffMock).not.toHaveBeenCalled();
    expect(scheduleGatewayRestartMock).not.toHaveBeenCalled();

    const lookupCount = vi.mocked(resolveNpmChannelTag).mock.calls.length;
    await runExtendedStableUpdateCheck({ log, onUpdateAvailableChange });
    expect(resolveNpmChannelTag).toHaveBeenCalledTimes(lookupCount);
  });

  it("does not resolve the npm channel for an extended-stable Git install", async () => {
    await seedExtendedStableAvailability();
    seedStableAutoRolloutState();
    resetUpdateAvailableStateForTest(scheduler);
    vi.mocked(resolveOpenClawPackageRoot).mockClear();
    vi.mocked(checkUpdateStatus).mockClear();
    vi.mocked(resolveNpmChannelTag).mockClear();
    vi.mocked(resolveOpenClawPackageRoot).mockResolvedValue("/opt/openclaw");
    vi.mocked(checkUpdateStatus).mockResolvedValue({
      root: "/opt/openclaw",
      installKind: "git",
      packageManager: "unknown",
    } satisfies UpdateCheckResult);
    const runAutoUpdate = createAutoUpdateSuccessMock();
    const onUpdateAvailableChange = vi.fn();

    await runExtendedStableUpdateCheck({ onUpdateAvailableChange, runAutoUpdate });

    expect(checkUpdateStatus).toHaveBeenCalledTimes(1);
    expect(resolveNpmChannelTag).not.toHaveBeenCalled();
    expect(runAutoUpdate).not.toHaveBeenCalled();
    expect(onUpdateAvailableChange).not.toHaveBeenCalled();
    expect(getUpdateAvailable()).toBeNull();
    expect(readPersistedUpdateCheckState()).toMatchObject({
      lastAvailableVersion: "2.0.0",
      lastAvailableTag: "extended-stable",
    });
    expectStableAutoRolloutStatePreserved();
  });

  it("skips all extended-stable work in Nix mode", async () => {
    const runAutoUpdate = createAutoUpdateSuccessMock();

    await runExtendedStableUpdateCheck({ isNixMode: true, runAutoUpdate });

    expect(resolveOpenClawPackageRoot).not.toHaveBeenCalled();
    expect(checkUpdateStatus).not.toHaveBeenCalled();
    expect(resolveNpmChannelTag).not.toHaveBeenCalled();
    expect(checkTelemetryUpdateMock).not.toHaveBeenCalled();
    expect(runAutoUpdate).not.toHaveBeenCalled();
    expect(readPersistedUpdateCheckState()).toBeNull();
  });

  it("defers stable auto-update until rollout window is due", async () => {
    mockPackageUpdateStatus("latest", "2.0.0");

    const runAutoUpdate = vi.fn().mockResolvedValue({
      status: "handoff",
    });
    const stableAutoConfig = {
      update: {
        channel: "stable" as const,
        auto: {
          enabled: true,
        },
      },
    };

    await runGatewayUpdateCheck({
      cfg: stableAutoConfig,
      activeWorkInspectors: idleActiveWorkInspectors(),
      runAutoUpdate,
    });
    expect(runAutoUpdate).not.toHaveBeenCalled();

    clock.setTime(Date.parse("2026-01-18T07:00:00Z"));
    await runGatewayUpdateCheck({
      cfg: stableAutoConfig,
      activeWorkInspectors: idleActiveWorkInspectors(),
      runAutoUpdate,
    });
    await clock.advanceBy(60_000);

    expect(runAutoUpdate).toHaveBeenCalledTimes(1);
    expect(runAutoUpdate).toHaveBeenCalledWith({
      channel: "stable",
      runId: listUpdateRuns()[0]?.runId,
      signal: expect.any(AbortSignal),
      mode: "npm",
      timeoutMs: 45 * 60 * 1000,
      restartDrainTimeoutMs: 300_000,
      root: "/opt/openclaw",
      packageTargetVersion: "2.0.0",
    });
  });

  it("ends a held stable campaign when its replacement target is not yet due", async () => {
    const campaign = new UpdateCampaignController(scheduler);
    currentUpdateCheckLifecycle().campaign = campaign;
    const runAutoUpdate = createAutoUpdateSuccessMock();
    const cfg = { update: { channel: "stable" as const, auto: { enabled: true } } };
    mockPackageUpdateStatus("latest", "2.0.0");
    writePersistedUpdateCheckState({
      autoInstallId: "stable-held-install",
      autoFirstSeenVersion: "2.0.0",
      autoFirstSeenTag: "latest",
      autoFirstSeenAt: new Date(Date.now() - 24 * 60 * 60_000).toISOString(),
    });
    const check = () =>
      runGatewayUpdateCheck({
        cfg,
        activeWorkInspectors: idleActiveWorkInspectors(),
        runAutoUpdate,
      });

    try {
      await check();
      expect(campaign.hold()).toBe(true);
      clock.setTime(Date.now() + 60 * 60_000);
      mockNpmChannelTag("latest", "3.0.0");

      await check();

      expect(getUpdateSchedule()?.target).toEqual({ kind: "package", version: "3.0.0" });
      expect(getUpdateSchedule()?.campaign).toBeUndefined();
      await clock.advanceBy(65_000);
      expect(runAutoUpdate).not.toHaveBeenCalled();
    } finally {
      campaign.clear();
    }
  });

  it("disables all automatic update traffic when checkOnStart is false", async () => {
    mockPackageUpdateStatus("beta", "2.0.0-beta.1");
    const runAutoUpdate = createAutoUpdateSuccessMock();
    const log = { info: vi.fn() };

    await runGatewayUpdateCheck({
      cfg: { update: { ...createBetaAutoUpdateConfig().update, checkOnStart: false } },
      runAutoUpdate,
      log,
    });

    await clock.advanceBy(60_000);

    expect(log.info).not.toHaveBeenCalled();
    expect(readPersistedUpdateCheckState()).toBeNull();
    expect(runAutoUpdate).not.toHaveBeenCalled();
    expect(checkTelemetryUpdateMock).not.toHaveBeenCalled();
    expect(resolveNpmChannelTag).not.toHaveBeenCalled();
    expect(checkUpdateStatus).not.toHaveBeenCalled();
    expect(getUpdateAvailable()).toBeNull();
    expect(getUpdateSchedule()).toMatchObject({ channel: "beta", autoEnabled: false });
  });

  it("disables update notices, telemetry, and auto-update with OPENCLAW_NO_AUTO_UPDATE", async () => {
    mockPackageUpdateStatus("beta", "2.0.0-beta.1");
    process.env.OPENCLAW_NO_AUTO_UPDATE = "1";
    const log = { info: vi.fn() };
    const runAutoUpdate = createAutoUpdateSuccessMock();

    await runGatewayUpdateCheck({
      cfg: createBetaAutoUpdateConfig(),
      log,
      runAutoUpdate,
    });

    expect(runAutoUpdate).not.toHaveBeenCalled();
    expect(checkTelemetryUpdateMock).not.toHaveBeenCalled();
    expect(resolveNpmChannelTag).not.toHaveBeenCalled();
    expect(checkUpdateStatus).not.toHaveBeenCalled();
    expect(log.info).not.toHaveBeenCalled();
  });

  it("keeps external auto-update supervision authoritative over native systemd markers", async () => {
    mockPackageUpdateStatus("beta", "2.0.0-beta.1");
    process.env.OPENCLAW_SUPERVISOR_MODE = "external";
    process.env.OPENCLAW_SYSTEMD_UNIT = "openclaw-gateway.service";
    detectRespawnSupervisorMock.mockReturnValue("systemd");
    const log = { info: vi.fn() };
    const runAutoUpdate = createAutoUpdateSuccessMock();

    await runGatewayUpdateCheck({
      cfg: createBetaAutoUpdateConfig(),
      log,
      runAutoUpdate,
    });

    expect(runAutoUpdate).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledWith("auto-update delegated to external supervisor", {
      version: "2.0.0-beta.1",
      tag: "beta",
      reason: "external-supervisor-update-required",
    });
  });
});
