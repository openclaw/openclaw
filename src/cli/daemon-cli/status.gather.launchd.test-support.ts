import { expect, it } from "vitest";
import type { StaleOpenClawUpdateLaunchdJob } from "../../daemon/launchd.js";
import { withMockedPlatform } from "../../test-utils/vitest-spies.js";

export const staleUpdateLaunchdJobsFixture: StaleOpenClawUpdateLaunchdJob[] = [
  { label: "ai.openclaw.update.2026.5.12", lastExitStatus: 127 },
  { label: "ai.openclaw.manual-update.1717168800", lastExitStatus: 0 },
];

type ScanStatus = {
  service: {
    staleUpdateLaunchdJobs?: readonly StaleOpenClawUpdateLaunchdJob[];
    staleLaunchdInspectionError?: string;
  };
};

export function registerStatusLaunchdScanTests(params: {
  gatherStatus: (deep: boolean) => Promise<ScanStatus>;
  setServiceCommand: () => void;
  setStaleScan: (scanFails: boolean, jobs: typeof staleUpdateLaunchdJobsFixture) => void;
  staleScanEnv: () => NodeJS.ProcessEnv | undefined;
}) {
  it.each([
    { label: "jobs", scanFails: false },
    { label: "scan failure", scanFails: true },
  ])("surfaces stale updater $label during deep status", ({ scanFails }) =>
    withMockedPlatform("darwin", async () => {
      params.setServiceCommand();
      params.setStaleScan(scanFails, staleUpdateLaunchdJobsFixture);
      const status = await params.gatherStatus(true);
      expect(params.staleScanEnv()).toMatchObject({
        OPENCLAW_STATE_DIR: "/tmp/openclaw-daemon",
        OPENCLAW_CONFIG_PATH: "/tmp/openclaw-daemon/openclaw.json",
        OPENCLAW_LAUNCHD_LABEL: "ai.openclaw.manual-update.gateway",
      });
      expect(status.service.staleUpdateLaunchdJobs).toEqual(
        scanFails ? undefined : staleUpdateLaunchdJobsFixture,
      );
      expect(status.service.staleLaunchdInspectionError).toEqual(
        scanFails ? expect.stringContaining("launchctl list failed") : undefined,
      );
    }),
  );
}
