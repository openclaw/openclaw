import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { writeConfigMachineState } from "../state/config-machine-state-write.js";
import { closeStateDatabaseForTest } from "../test-utils/database-cleanup.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { resolveOpenClawPackageRoot } from "./openclaw-root.js";
import { createGatewayUpdateLifecycle } from "./update-check-lifecycle.js";
import { checkUpdateStatus, resolveNpmChannelTag } from "./update-check.js";
import { runGatewayUpdateCheck } from "./update-startup.js";
import { getGatewayUpdateSchedule } from "./update-status-schedule.js";
import { getUpdateAvailable, resetUpdateStatusState } from "./update-status-state.js";

const { checkTelemetryUpdateMock, versionMock } = await vi.hoisted(
  () => import("./update-startup.test-support.js"),
);

let state: OpenClawTestState;
let lifecycle: ReturnType<typeof createGatewayUpdateLifecycle>;
beforeEach(async () => {
  state = await createOpenClawTestState({
    layout: "state-only",
    prefix: "openclaw-update-cached-",
    env: { OPENCLAW_PROFILE: undefined, OPENCLAW_NO_AUTO_UPDATE: undefined },
  });
  resetUpdateStatusState();
  lifecycle = createGatewayUpdateLifecycle(createTestGatewayScheduler());
  versionMock.value = "1.0.0";
  vi.mocked(checkUpdateStatus).mockClear();
  vi.mocked(resolveNpmChannelTag).mockClear();
  checkTelemetryUpdateMock.mockReset().mockResolvedValue(null);
});
afterEach(async () => {
  await lifecycle.stop();
  await lifecycle.scheduler.stop();
  resetUpdateStatusState();
  await state.cleanup();
});
afterAll(closeStateDatabaseForTest);

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
