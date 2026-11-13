import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  closeUpdateFixtureDatabases,
  resetUpdateFixtureModules,
} from "./update-fixture.test-support.js";

let { MACOS_APP_INSTALL_OWNER_MARKER } = await import("../commands/test-runtime-config-helpers.js");
let { runCommandWithTimeout } = await import("../process/exec.js");
let { createTestGatewayScheduler } = await import("../test-utils/gateway-scheduler-clock.js");
let { resolveOpenClawPackageRoot } = await import("./openclaw-root.js");
let { checkTelemetryUpdate } = await import("./telemetry.js");
let { createGatewayUpdateLifecycle } = await import("./update-check-lifecycle.js");
let { resolveNpmChannelTag } = await import("./update-check.js");
let autoRun = await import("./update-startup-auto-run.js");
let { runGatewayUpdateCheck } = await import("./update-startup.js");
let { getUpdateAvailable, getUpdateSchedule } = await import("./update-status-state.js");

async function importUpdateFixtureModules() {
  ({ MACOS_APP_INSTALL_OWNER_MARKER } = await import("../commands/test-runtime-config-helpers.js"));
  ({ runCommandWithTimeout } = await import("../process/exec.js"));
  ({ createTestGatewayScheduler } = await import("../test-utils/gateway-scheduler-clock.js"));
  ({ resolveOpenClawPackageRoot } = await import("./openclaw-root.js"));
  ({ checkTelemetryUpdate } = await import("./telemetry.js"));
  ({ createGatewayUpdateLifecycle } = await import("./update-check-lifecycle.js"));
  ({ resolveNpmChannelTag } = await import("./update-check.js"));
  autoRun = await import("./update-startup-auto-run.js");
  ({ runGatewayUpdateCheck } = await import("./update-startup.js"));
  ({ getUpdateAvailable, getUpdateSchedule } = await import("./update-status-state.js"));
}

vi.mock("./openclaw-root.js", async (original) => ({
  ...(await original<typeof import("./openclaw-root.js")>()),
  resolveOpenClawPackageRoot: vi.fn(),
}));
vi.mock("./restart-sentinel.js", async (original) => ({
  ...(await original<typeof import("./restart-sentinel.js")>()),
  readVerifiedGitUpdateReceipt: async () => null,
}));
vi.mock("./update-check.js", async (original) => ({
  ...(await original<typeof import("./update-check.js")>()),
  resolveNpmChannelTag: vi.fn(),
}));
vi.mock("./telemetry.js", () => ({ checkTelemetryUpdate: vi.fn() }));
vi.mock("../process/exec.js", () => ({ runCommandWithTimeout: vi.fn() }));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
let lifecycle: ReturnType<typeof createGatewayUpdateLifecycle>;
beforeEach(async () => {
  await resetUpdateFixtureModules();
  await importUpdateFixtureModules();
  lifecycle = createGatewayUpdateLifecycle(createTestGatewayScheduler());
  vi.stubEnv("OPENCLAW_NO_AUTO_UPDATE", undefined);
  vi.clearAllMocks();
});
afterEach(async () => {
  await lifecycle.stop();
  await lifecycle.scheduler.stop();
  await closeUpdateFixtureDatabases();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it.each(["stable", "beta", "dev", "extended-stable"] as const)(
  "skips remote discovery and automatic updates for app-owned installs on %s",
  async (channel) => {
    const root = tempDirs.make("openclaw-app-startup-update-");
    await fs.writeFile(
      path.join(root, "openclaw-install-owner.json"),
      MACOS_APP_INSTALL_OWNER_MARKER,
    );
    vi.mocked(resolveOpenClawPackageRoot).mockResolvedValue(root);
    const runAutoUpdate = vi
      .spyOn(autoRun, "runAutoUpdateCommand")
      .mockResolvedValue({ status: "handoff" });

    await runGatewayUpdateCheck(
      {
        getConfig: () => ({ update: { channel, auto: { enabled: true } } }),
        log: { info: vi.fn() },
        allowInTests: true,
        isNixMode: false,
      },
      lifecycle,
    );

    expect(checkTelemetryUpdate).not.toHaveBeenCalled();
    expect(resolveNpmChannelTag).not.toHaveBeenCalled();
    expect(runCommandWithTimeout).not.toHaveBeenCalled();
    expect(runAutoUpdate).not.toHaveBeenCalled();
    expect(getUpdateAvailable()).toBeNull();
    expect(getUpdateSchedule()).toEqual({ channel, autoEnabled: false });
    expect(lifecycle.campaign?.getState()).toBeUndefined();
  },
);
