import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { UpdateCheckLifecycle } from "./update-check-lifecycle.js";
import {
  closeUpdateFixtureDatabases,
  resetUpdateFixtureModules,
} from "./update-fixture.test-support.js";

let { createTestGatewayScheduler } = await import("../test-utils/gateway-scheduler-clock.js");
let { createGatewayUpdateLifecycle } = await import("./update-check-lifecycle.js");
let autoRun = await import("./update-startup-auto-run.js");
let { runGatewayUpdateCheck } = await import("./update-startup.js");
let { getUpdateAvailable, getUpdateSchedule } = await import("./update-status-state.js");

async function importUpdateFixtureModules() {
  ({ createTestGatewayScheduler } = await import("../test-utils/gateway-scheduler-clock.js"));
  ({ createGatewayUpdateLifecycle } = await import("./update-check-lifecycle.js"));
  autoRun = await import("./update-startup-auto-run.js");
  ({ runGatewayUpdateCheck } = await import("./update-startup.js"));
  ({ getUpdateAvailable, getUpdateSchedule } = await import("./update-status-state.js"));
}

const mocks = vi.hoisted(() => ({
  telemetry: vi.fn(async () => null),
  writeState: vi.fn(),
  runAutoUpdate: vi.fn(),
}));
vi.mock("./telemetry.js", () => ({ checkTelemetryUpdate: mocks.telemetry }));
// mock-isolation: Update selection uses synthetic machine state without opening SQLite.
vi.mock("../state/config-machine-state-async.js", () => ({
  readConfigMachineStateAsync: async () => null,
  writeConfigMachineStateAsync: mocks.writeState,
}));

let lifecycle: UpdateCheckLifecycle;
beforeEach(async () => {
  await resetUpdateFixtureModules();
  await importUpdateFixtureModules();
  vi.clearAllMocks();
  vi.spyOn(autoRun, "runAutoUpdateCommand").mockImplementation(mocks.runAutoUpdate);
  vi.stubEnv("OPENCLAW_NO_AUTO_UPDATE", "");
  lifecycle = createGatewayUpdateLifecycle(createTestGatewayScheduler());
});
afterEach(async () => {
  await lifecycle.stop();
  await lifecycle.scheduler.stop();
  await closeUpdateFixtureDatabases();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it.each(["stable", "dev"] as const)(
  "keeps immutable preparation outside automatic activation on %s",
  async (channel) => {
    const immutable = {
      root: "/opt/openclaw",
      currentSha: "a".repeat(40),
      currentPath: `/opt/openclaw/releases/${"a".repeat(40)}`,
    };
    lifecycle.installStatus = {
      root: immutable.currentPath,
      installReceipt: null,
      status: {
        root: immutable.currentPath,
        installKind: "immutable",
        immutable,
        packageManager: "unknown",
        registry: { latestVersion: "99.0.0" },
      },
    };

    await runGatewayUpdateCheck(
      {
        getConfig: () => ({ update: { channel, auto: { enabled: true } } }),
        log: { info: vi.fn() },
        isNixMode: false,
        allowInTests: true,
      },
      lifecycle,
    );

    expect(getUpdateSchedule()).toEqual({
      channel,
      autoEnabled: false,
      install: { kind: "immutable", immutable },
    });
    expect(getUpdateAvailable()).toBeNull();
    expect(mocks.runAutoUpdate).not.toHaveBeenCalled();
    expect(mocks.telemetry).not.toHaveBeenCalled();
    expect(mocks.writeState).not.toHaveBeenCalled();
  },
);
