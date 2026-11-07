import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { OpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  closeUpdateFixtureDatabases,
  resetUpdateFixtureModules,
} from "./update-fixture.test-support.js";
import { idleActiveWorkInspectors } from "./update-startup-suite.test-support.js";

let { sessionChanges } = await import("../sessions/session-row-changes.js");
let { createGatewaySchedulerClock, createTestGatewayScheduler } =
  await import("../test-utils/gateway-scheduler-clock.js");
let { createOpenClawTestState } = await import("../test-utils/openclaw-test-state.js");
let { resolveOpenClawPackageRoot } = await import("./openclaw-root.js");
let { createGatewayUpdateLifecycle } = await import("./update-check-lifecycle.js");
let { checkUpdateStatus, resolveNpmChannelTag } = await import("./update-check.js");
let autoRun = await import("./update-startup-auto-run.js");
let { createGatewayUpdateCheck } = await import("./update-startup-scheduler.js");
let { runGatewayUpdateCheck } = await import("./update-startup.js");
let { getUpdateSchedule } = await import("./update-status-state.js");

async function importUpdateFixtureModules() {
  ({ sessionChanges } = await import("../sessions/session-row-changes.js"));
  ({ createGatewaySchedulerClock, createTestGatewayScheduler } =
    await import("../test-utils/gateway-scheduler-clock.js"));
  ({ createOpenClawTestState } = await import("../test-utils/openclaw-test-state.js"));
  ({ resolveOpenClawPackageRoot } = await import("./openclaw-root.js"));
  ({ createGatewayUpdateLifecycle } = await import("./update-check-lifecycle.js"));
  ({ checkUpdateStatus, resolveNpmChannelTag } = await import("./update-check.js"));
  autoRun = await import("./update-startup-auto-run.js");
  ({ createGatewayUpdateCheck } = await import("./update-startup-scheduler.js"));
  ({ runGatewayUpdateCheck } = await import("./update-startup.js"));
  ({ getUpdateSchedule } = await import("./update-status-state.js"));
}

const { checkTelemetryUpdateMock, versionMock } = await vi.hoisted(
  () => import("./update-startup.test-support.js"),
);
let state: OpenClawTestState;
let clock: ReturnType<typeof createGatewaySchedulerClock>;
let scheduler: ReturnType<typeof createTestGatewayScheduler>;
let lifecycle: ReturnType<typeof createGatewayUpdateLifecycle>;
let check: ReturnType<typeof createGatewayUpdateCheck> | undefined;
beforeEach(async () => {
  await resetUpdateFixtureModules();
  await importUpdateFixtureModules();
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
  await scheduler.stop();
  await closeUpdateFixtureDatabases();
  vi.restoreAllMocks();
  await state.cleanup();
});
afterAll(closeUpdateFixtureDatabases);

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
  const run = vi.fn<typeof autoRun.runAutoUpdateCommand>(async () => ({ status: "handoff" }));
  mockAutoUpdate(run);
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
  await lifecycle.stop();
  await scheduler.stop();
  await resetUpdateFixtureModules();
  await importUpdateFixtureModules();
  scheduler = createTestGatewayScheduler(clock.clock);
  lifecycle = createGatewayUpdateLifecycle(scheduler);
  mockAutoUpdate(run);
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
