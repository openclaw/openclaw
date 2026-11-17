import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { OpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  closeUpdateFixtureDatabases,
  resetUpdateFixtureModules,
} from "./update-fixture.test-support.js";

let { writeConfigMachineState } = await import("../state/config-machine-state-write.js");
let { readConfigMachineState } = await import("../state/config-machine-state.js");
let { createGatewaySchedulerClock, createTestGatewayScheduler } =
  await import("../test-utils/gateway-scheduler-clock.js");
let { createOpenClawTestState } = await import("../test-utils/openclaw-test-state.js");
let { resolveOpenClawPackageRoot } = await import("./openclaw-root.js");
let { createGatewayUpdateLifecycle } = await import("./update-check-lifecycle.js");
let { checkUpdateStatus, resolveNpmChannelTag } = await import("./update-check.js");
let { createGatewayUpdateCheck } = await import("./update-startup-scheduler.js");
let { runGatewayUpdateCheck } = await import("./update-startup.js");
let { getGatewayUpdateSchedule } = await import("./update-status-schedule.js");
let { getUpdateAvailable } = await import("./update-status-state.js");

async function importUpdateFixtureModules() {
  ({ writeConfigMachineState } = await import("../state/config-machine-state-write.js"));
  ({ readConfigMachineState } = await import("../state/config-machine-state.js"));
  ({ createGatewaySchedulerClock, createTestGatewayScheduler } =
    await import("../test-utils/gateway-scheduler-clock.js"));
  ({ createOpenClawTestState } = await import("../test-utils/openclaw-test-state.js"));
  ({ resolveOpenClawPackageRoot } = await import("./openclaw-root.js"));
  ({ createGatewayUpdateLifecycle } = await import("./update-check-lifecycle.js"));
  ({ checkUpdateStatus, resolveNpmChannelTag } = await import("./update-check.js"));
  ({ createGatewayUpdateCheck } = await import("./update-startup-scheduler.js"));
  ({ runGatewayUpdateCheck } = await import("./update-startup.js"));
  ({ getGatewayUpdateSchedule } = await import("./update-status-schedule.js"));
  ({ getUpdateAvailable } = await import("./update-status-state.js"));
}

const { checkTelemetryUpdateMock, versionMock } = await vi.hoisted(
  () => import("./update-startup.test-support.js"),
);

let state: OpenClawTestState;
let lifecycle: ReturnType<typeof createGatewayUpdateLifecycle>;
beforeEach(async () => {
  await resetUpdateFixtureModules();
  await importUpdateFixtureModules();
  state = await createOpenClawTestState({
    layout: "state-only",
    prefix: "openclaw-update-cached-",
    env: { OPENCLAW_PROFILE: undefined, OPENCLAW_NO_AUTO_UPDATE: undefined },
  });
  lifecycle = createGatewayUpdateLifecycle(createTestGatewayScheduler());
  versionMock.value = "1.0.0";
  vi.mocked(checkUpdateStatus).mockClear();
  vi.mocked(resolveNpmChannelTag).mockClear();
  checkTelemetryUpdateMock.mockReset().mockResolvedValue(null);
});
afterEach(async () => {
  await lifecycle.stop();
  await lifecycle.scheduler.stop();
  await closeUpdateFixtureDatabases();
  await state.cleanup();
});
afterAll(closeUpdateFixtureDatabases);

function mockStablePackageInstall() {
  vi.mocked(resolveOpenClawPackageRoot).mockResolvedValue("/opt/openclaw");
  vi.mocked(checkUpdateStatus).mockResolvedValue({
    root: "/opt/openclaw",
    installKind: "package",
    packageManager: "npm",
  });
}

function runStableCheck(cfg: OpenClawConfig = { update: { channel: "stable" } }) {
  return runGatewayUpdateCheck({
    getConfig: () => cfg,
    log: { info: vi.fn() },
    isNixMode: false,
    allowInTests: true,
  });
}

it.each([
  { published: undefined, telemetryVersion: "2.0.0" },
  { published: "2.0.0", telemetryVersion: "2.1.0" },
])(
  "publishes cached telemetry release $telemetryVersion within the daily throttle",
  async ({ published, telemetryVersion }) => {
    writeConfigMachineState("update.checkState", {
      lastCheckedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      lastCheckedChannel: "stable",
      lastNotifiedVersion: published ?? "1.0.0",
      ...(published ? { lastAvailableVersion: published, lastAvailableTag: "latest" } : {}),
    });
    mockStablePackageInstall();
    checkTelemetryUpdateMock.mockResolvedValue({ version: telemetryVersion });

    await runStableCheck();

    expect(getUpdateAvailable()).toEqual({
      currentVersion: "1.0.0",
      latestVersion: telemetryVersion,
      channel: "latest",
    });
    expect(readConfigMachineState("update.checkState")).toMatchObject({
      lastAvailableVersion: telemetryVersion,
      lastNotifiedVersion: telemetryVersion,
    });
    expect(resolveNpmChannelTag).not.toHaveBeenCalled();
  },
);

it.each([
  { name: "already published", lastAvailableVersion: "2.0.0", telemetryVersion: "2.0.0" },
  {
    name: "not newer than this install",
    lastAvailableVersion: undefined,
    telemetryVersion: "1.0.0",
  },
])("keeps the daily throttle when the telemetry release is $name", async (fixture) => {
  const checkState = {
    lastCheckedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    lastCheckedChannel: "stable",
    ...(fixture.lastAvailableVersion
      ? { lastAvailableVersion: fixture.lastAvailableVersion, lastAvailableTag: "latest" }
      : {}),
  };
  writeConfigMachineState("update.checkState", checkState);
  mockStablePackageInstall();
  checkTelemetryUpdateMock.mockResolvedValue({ version: fixture.telemetryVersion });

  await runStableCheck();

  expect(readConfigMachineState("update.checkState")).toEqual(checkState);
});

it("keeps the auto-update throttle on its npm lookup", async () => {
  const checkState = {
    lastCheckedAt: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
    lastCheckedChannel: "stable",
  };
  writeConfigMachineState("update.checkState", checkState);
  mockStablePackageInstall();
  checkTelemetryUpdateMock.mockResolvedValue({ version: "2.0.0" });

  await runStableCheck({ update: { channel: "stable", auto: { enabled: true } } });

  expect(getUpdateAvailable()).toBeNull();
  expect(resolveNpmChannelTag).not.toHaveBeenCalled();
  expect(readConfigMachineState("update.checkState")).toEqual(checkState);
});

it("re-reads a refreshed telemetry cache on the hourly stable schedule", async () => {
  const clock = createGatewaySchedulerClock(Date.parse("2026-01-17T10:00:00Z"));
  const now = vi.spyOn(Date, "now").mockImplementation(clock.clock.now);
  vi.stubEnv("VITEST", "");
  vi.stubEnv("NODE_ENV", "production");
  mockStablePackageInstall();
  const scheduled = createGatewayUpdateCheck({
    lifecycle: createGatewayUpdateLifecycle(createTestGatewayScheduler(clock.clock)),
    getConfig: () => ({ update: { channel: "stable" } }),
    applyRemoteCatalogUpdate: async () => "unchanged",
    log: { info: vi.fn() },
    isNixMode: false,
  });
  try {
    scheduled.start();
    await clock.advanceBy(0);
    expect(getUpdateAvailable()).toBeNull();

    // Gateway maintenance or a CLI run refreshes the shared telemetry cache.
    checkTelemetryUpdateMock.mockResolvedValue({ version: "2.0.0" });
    await clock.advanceBy(60 * 60 * 1000);

    expect(getUpdateAvailable()).toEqual({
      currentVersion: "1.0.0",
      latestVersion: "2.0.0",
      channel: "latest",
    });
    expect(readConfigMachineState("update.checkState")).toMatchObject({
      lastCheckedAt: "2026-01-17T11:00:00.000Z",
      lastAvailableVersion: "2.0.0",
    });
    expect(resolveNpmChannelTag).not.toHaveBeenCalled();
  } finally {
    await scheduled.stop();
    now.mockRestore();
  }
});

it.each([
  { channel: "stable", installKind: "package" },
  { channel: "beta", installKind: "package" },
  { channel: "stable", installKind: "unknown" },
] as const)(
  "publishes discovered $installKind facts for a current cached $channel install",
  async ({ channel, installKind }) => {
    writeConfigMachineState("update.checkState", {
      lastCheckedAt: new Date(Date.now()).toISOString(),
      lastCheckedChannel: channel,
      lastAvailableVersion: "1.0.0",
      lastAvailableTag: channel === "stable" ? "latest" : "beta",
    });
    vi.mocked(resolveOpenClawPackageRoot).mockResolvedValue("/opt/openclaw");
    vi.mocked(checkUpdateStatus).mockResolvedValue({
      root: "/opt/openclaw",
      installKind,
      packageManager: installKind === "package" ? "npm" : "unknown",
    });
    const cfg: OpenClawConfig = { update: { channel } };
    const onUpdateScheduleChange = vi.fn();

    await runGatewayUpdateCheck({
      getConfig: () => cfg,
      onUpdateScheduleChange,
      log: { info: vi.fn() },
      isNixMode: false,
      allowInTests: true,
    });

    const expected = { channel, autoEnabled: false, install: { kind: installKind } };
    expect(getGatewayUpdateSchedule(cfg, channel)).toEqual(expected);
    expect(onUpdateScheduleChange).toHaveBeenLastCalledWith(expected);
    expect(getUpdateAvailable()).toBeNull();
    expect(checkUpdateStatus).toHaveBeenCalledTimes(1);
    expect(resolveNpmChannelTag).not.toHaveBeenCalled();
  },
);
