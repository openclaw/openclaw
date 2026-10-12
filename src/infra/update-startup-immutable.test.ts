import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import {
  createGatewayUpdateLifecycle,
  type UpdateCheckLifecycle,
} from "./update-check-lifecycle.js";
import { runGatewayUpdateCheck } from "./update-startup.js";
import {
  getUpdateAvailable,
  getUpdateSchedule,
  resetUpdateStatusState,
} from "./update-status-state.js";

const mocks = vi.hoisted(() => ({
  telemetry: vi.fn(async () => null),
  writeState: vi.fn(),
  runAutoUpdate: vi.fn(),
}));
vi.mock("./telemetry.js", () => ({ checkTelemetryUpdate: mocks.telemetry }));
// mock-isolation: Update selection reads synthetic machine state without opening SQLite.
vi.mock("../state/config-machine-state-async.js", () => ({
  readConfigMachineStateAsync: async () => null,
}));
// mock-isolation: Record update state writes without involving the shared writer broker.
vi.mock("../state/config-machine-state-write-async.js", () => ({
  writeConfigMachineStateAsync: mocks.writeState,
}));

let lifecycle: UpdateCheckLifecycle;
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("OPENCLAW_NO_AUTO_UPDATE", "");
  resetUpdateStatusState();
  lifecycle = createGatewayUpdateLifecycle(createTestGatewayScheduler());
});
afterEach(async () => {
  await lifecycle.stop();
  await lifecycle.scheduler.stop();
  resetUpdateStatusState();
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
        runAutoUpdate: mocks.runAutoUpdate,
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
