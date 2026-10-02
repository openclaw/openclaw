import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { runCommandWithTimeout } from "../process/exec.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import { resolveOpenClawPackageRoot } from "./openclaw-root.js";
import { checkTelemetryUpdate } from "./telemetry.js";
import { createGatewayUpdateLifecycle } from "./update-check-lifecycle.js";
import { resolveNpmChannelTag } from "./update-check.js";
import { runGatewayUpdateCheck } from "./update-startup.js";
import {
  getUpdateAvailable,
  getUpdateSchedule,
  resetUpdateStatusState,
} from "./update-status-state.js";

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
beforeEach(() => {
  lifecycle = createGatewayUpdateLifecycle(createTestGatewayScheduler());
  vi.stubEnv("OPENCLAW_NO_AUTO_UPDATE", undefined);
  vi.clearAllMocks();
});
afterEach(async () => {
  await lifecycle.stop();
  await lifecycle.scheduler.stop();
  resetUpdateStatusState();
  vi.unstubAllEnvs();
});

it.each(["stable", "beta", "dev", "extended-stable"] as const)(
  "skips remote discovery and automatic updates for app-owned installs on %s",
  async (channel) => {
    const root = tempDirs.make("openclaw-app-startup-update-");
    await fs.writeFile(
      path.join(root, "openclaw-install-owner.json"),
      JSON.stringify({
        schemaVersion: 1,
        owner: "macos-app",
        displayName: "OpenClaw.app",
        updateHint: "Update OpenClaw.app to update this Gateway.",
      }),
    );
    vi.mocked(resolveOpenClawPackageRoot).mockResolvedValue(root);
    const runAutoUpdate = vi.fn();

    await runGatewayUpdateCheck(
      {
        getConfig: () => ({ update: { channel, auto: { enabled: true } } }),
        log: { info: vi.fn() },
        allowInTests: true,
        isNixMode: false,
        runAutoUpdate,
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
