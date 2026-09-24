import { afterEach, expect, it, vi } from "vitest";
import { writeConfigMachineState } from "../state/config-machine-state-write.js";
import { readConfigMachineState } from "../state/config-machine-state.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { checkUpdateStatus, resolveNpmChannelTag } from "./update-check.js";
import { resetUpdateAvailableStateForTest, runGatewayUpdateCheck } from "./update-startup.js";
import {
  getUpdateAvailable,
  getUpdateSchedule,
  setUpdateAvailableCache,
} from "./update-status-state.js";

vi.mock("./openclaw-root.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./openclaw-root.js")>()),
  resolveOpenClawPackageRoot: vi.fn(async () => "/opt/openclaw"),
}));
vi.mock("./update-check.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./update-check.js")>()),
  checkUpdateStatus: vi.fn(),
  resolveNpmChannelTag: vi.fn(),
}));
afterEach(() => {
  resetUpdateAvailableStateForTest();
  vi.restoreAllMocks();
});

it.each(["owned", "uncertain"] as const)(
  "clears cached npm availability and automatic updates when pacman ownership is %s",
  async (ownership) => {
    const state = await createOpenClawTestState({
      layout: "state-only",
      prefix: "update-pacman-startup-",
      env: {
        OPENCLAW_PROFILE: undefined,
        OPENCLAW_NO_AUTO_UPDATE: undefined,
        OPENCLAW_SUPERVISOR_MODE: undefined,
      },
    });
    try {
      writeConfigMachineState("update.checkState", {
        lastCheckedAt: new Date().toISOString(),
        lastCheckedChannel: "stable",
        lastAvailableVersion: "9999.0.0",
        lastAvailableTag: "latest",
        autoFirstSeenVersion: "9999.0.0",
        autoFirstSeenTag: "latest",
        autoFirstSeenAt: new Date().toISOString(),
      });
      setUpdateAvailableCache({
        next: { currentVersion: "1.0.0", latestVersion: "9999.0.0", channel: "latest" },
      });
      vi.mocked(checkUpdateStatus).mockResolvedValue({
        root: "/opt/openclaw",
        installKind: "package",
        packageManager: "unknown",
        ...(ownership === "owned"
          ? {
              systemPackage: {
                manager: "pacman" as const,
                packageName: "openclaw",
                nextAction: "Use the distribution updater.",
              },
            }
          : {
              error: {
                status: "failed" as const,
                code: "pacman-ownership-unavailable" as const,
                message: "Pacman ownership could not be verified.",
              },
            }),
      });
      const runAutoUpdate = vi.fn();
      await runGatewayUpdateCheck({
        getConfig: () => ({ update: { channel: "stable", auto: { enabled: true } } }),
        log: { info: vi.fn() },
        isNixMode: false,
        allowInTests: true,
        runAutoUpdate,
      });
      expect(getUpdateAvailable()).toBeNull();
      expect(getUpdateSchedule()).toMatchObject({ autoEnabled: false });
      expect(getUpdateSchedule()?.target).toBeUndefined();
      expect(getUpdateSchedule()?.campaign).toBeUndefined();
      expect(readConfigMachineState("update.checkState")).not.toHaveProperty(
        "lastAvailableVersion",
      );
      expect(readConfigMachineState("update.checkState")).not.toHaveProperty(
        "autoFirstSeenVersion",
      );
      expect(resolveNpmChannelTag).not.toHaveBeenCalled();
      expect(runAutoUpdate).not.toHaveBeenCalled();
    } finally {
      closeOpenClawStateDatabaseForTest();
      await state.cleanup();
    }
  },
);
