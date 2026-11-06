import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
import { closeStateDatabaseForTest } from "../test-utils/database-cleanup.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../test-utils/gateway-scheduler-clock.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { resolveOpenClawPackageRoot } from "./openclaw-root.js";
import { createGatewayUpdateLifecycle } from "./update-check-lifecycle.js";
import { checkUpdateStatus, resolveNpmChannelTag } from "./update-check.js";
import * as autoRun from "./update-startup-auto-run.js";
import { createGatewayUpdateCheck } from "./update-startup-scheduler.js";
import { idleActiveWorkInspectors } from "./update-startup-suite.test-support.js";
import { runGatewayUpdateCheck, resetUpdateAvailableStateForTest } from "./update-startup.js";
import { getUpdateSchedule } from "./update-status-state.js";

const { checkTelemetryUpdateMock, versionMock } = await vi.hoisted(
  () => import("./update-startup.test-support.js"),
);
let state: OpenClawTestState;
let clock: ReturnType<typeof createGatewaySchedulerClock>;
let scheduler: ReturnType<typeof createTestGatewayScheduler>;
let lifecycle: ReturnType<typeof createGatewayUpdateLifecycle>;
let check: ReturnType<typeof createGatewayUpdateCheck> | undefined;
beforeEach(async () => {
  state = await createOpenClawTestState({
    layout: "state-only",
    prefix: "update-schedule-",
    env: {
      OPENCLAW_PROFILE: undefined,
      OPENCLAW_NO_AUTO_UPDATE: undefined,
      OPENCLAW_SUPERVISOR_MODE: undefined,
      NODE_ENV: "production",
      VITEST: undefined,
    },
  });
  versionMock.value = "1.0.0";
  clock = createGatewaySchedulerClock(Date.parse("2026-01-17T10:00:00Z"));
  vi.spyOn(Date, "now").mockImplementation(clock.clock.now);
  scheduler = createTestGatewayScheduler(clock.clock);
  resetUpdateAvailableStateForTest(scheduler);
  lifecycle = createGatewayUpdateLifecycle(scheduler);
  vi.mocked(resolveOpenClawPackageRoot).mockResolvedValue("/opt/openclaw");
  vi.mocked(checkUpdateStatus).mockResolvedValue({
    root: "/opt/openclaw",
    installKind: "package",
    packageManager: "npm",
  });
  vi.mocked(resolveNpmChannelTag).mockResolvedValue({ tag: "beta", version: "2.0.0-beta.1" });
  checkTelemetryUpdateMock.mockResolvedValue(null);
});
afterEach(async () => {
  await check?.stop();
  check = undefined;
  await lifecycle.stop();
  resetUpdateAvailableStateForTest(scheduler);
  await scheduler.stop();
  vi.restoreAllMocks();
  await state.cleanup();
});
afterAll(closeStateDatabaseForTest);

function checkAutomatically(cfg: OpenClawConfig) {
  return runGatewayUpdateCheck({
    getConfig: () => cfg,
    log: { info: vi.fn() },
    isNixMode: false,
    allowInTests: true,
    activeWorkInspectors: idleActiveWorkInspectors(),
  });
}
function mockAutoUpdate(
  implementation: typeof autoRun.runAutoUpdateCommand = async () => ({ status: "handoff" }),
) {
  return vi.spyOn(autoRun, "runAutoUpdateCommand").mockImplementation(implementation);
}
function createTestUpdateCheck(params: {
  cfg: () => OpenClawConfig;
  activeWorkInspectors: ReturnType<typeof idleActiveWorkInspectors>;
}) {
  return (check = createGatewayUpdateCheck({
    lifecycle,
    getConfig: params.cfg,
    activeWorkInspectors: params.activeWorkInspectors,
    log: { info: vi.fn() },
    isNixMode: false,
    applyRemoteCatalogUpdate: async () => "unchanged",
  }));
}

it("starts daily campaigns only in their scheduled minute, including after restart", async () => {
  const run = mockAutoUpdate();
  const cfg = {
    update: { channel: "beta" as const, auto: { enabled: true, schedule: "30 10 * * *" } },
  };
  await checkAutomatically(cfg);
  expect(getUpdateSchedule()?.campaign).toBeUndefined();
  clock.setTime(Date.parse("2026-01-17T10:30:00Z"));
  await checkAutomatically(cfg);
  expect(getUpdateSchedule()?.campaign?.state).toBe("countdown");
  await clock.advanceBy(60_000);
  expect(run).toHaveBeenCalledOnce();
  resetUpdateAvailableStateForTest(scheduler);
  clock.setTime(Date.parse("2026-01-17T12:00:00Z"));
  await checkAutomatically(cfg);
  expect(getUpdateSchedule()?.campaign).toBeUndefined();
  clock.setTime(Date.parse("2026-01-18T10:30:00Z"));
  await checkAutomatically(cfg);
  await clock.advanceBy(60_000);
  expect(run).toHaveBeenCalledTimes(2);
});

it("uses sub-hourly windows, skips clock jumps, and rearms hot schedule changes", async () => {
  mockAutoUpdate(async () => ({
    status: "skipped",
    message: "fixture",
    result: { status: "skipped", mode: "npm", steps: [], durationMs: 0 },
  }));
  let cfg: OpenClawConfig = {
    update: { channel: "beta", auto: { enabled: true, schedule: "*/5 * * * *" } },
  };
  process.env.NODE_ENV = "production";
  const updateCheck = createTestUpdateCheck({
    cfg: () => cfg,
    activeWorkInspectors: idleActiveWorkInspectors(),
  });
  updateCheck.start();
  await clock.advanceBy(0);
  expect(getUpdateSchedule()?.campaign?.state).toBe("countdown");
  await clock.advanceBy(60_000);
  expect(getUpdateSchedule()?.campaign).toBeUndefined();
  await clock.advanceTo(Date.parse("2026-01-17T10:05:00Z"));
  expect(getUpdateSchedule()?.campaign?.state).toBe("countdown");
  cfg = { update: { channel: "beta", auto: { enabled: true, schedule: "10 10 * * *" } } };
  sessionChanges.emit({ all: true, scope: "config-presentation" });
  await clock.advanceBy(0);
  expect(getUpdateSchedule()?.campaign).toBeUndefined();
  await clock.advanceTo(Date.parse("2026-01-17T10:12:00Z"));
  expect(getUpdateSchedule()?.campaign).toBeUndefined();
  cfg = { update: { channel: "beta", auto: { enabled: true, schedule: "13 10 * * *" } } };
  sessionChanges.emit({ all: true, scope: "config-presentation" });
  await clock.advanceBy(0);
  await clock.advanceBy(60_000);
  expect(getUpdateSchedule()?.campaign?.state).toBe("countdown");
});
