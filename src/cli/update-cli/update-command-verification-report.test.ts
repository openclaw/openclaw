import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  createUpdateRun,
  finishUpdateRun,
  getUpdateRun,
  recordUpdateRunVerification,
} from "../../infra/update-run-ledger.js";
import { renderUpdateRunReport } from "../../infra/update-run-report.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { recordUpdateGatewayHealth } from "./update-command-verification.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => closeOpenClawStateDatabaseForTest());

it("records foreground serving health without claiming an unknown native service is stopped", () => {
  const env = { ...process.env, OPENCLAW_STATE_DIR: tempDirs.make("foreground-recovery-") };
  const run = { runId: createUpdateRun({ trigger: "cli" }, { env }).runId, env };
  recordUpdateGatewayHealth(
    run,
    {
      runtime: { status: "unknown" },
      portUsage: { port: 19123, status: "busy", listeners: [], hints: [] },
      healthy: true,
      staleGatewayPids: [],
      expectedVersion: "2026.9.5",
      gatewayVersion: "2026.9.5",
    },
    19123,
    true,
  );
  const recorded = getUpdateRun(run.runId, { env });
  expect(recorded?.verification).toMatchObject({
    runningVersion: "2026.9.5",
    versionMatch: true,
    readyz: true,
    settled: true,
  });
  expect(recorded?.verification.serviceRunning).toBeUndefined();
});

it.each([undefined, "2026.9.2", "2026.9.4"])(
  "reports only the currently observed version during startup (%s)",
  (gatewayVersion) => {
    const env = {
      ...process.env,
      OPENCLAW_STATE_DIR: tempDirs.make("update-identity-unavailable-"),
    };
    const run = { runId: createUpdateRun({ trigger: "cli" }, { env }).runId, env };
    recordUpdateRunVerification(
      run.runId,
      { runningVersion: "2026.9.2", runningBuildId: "previous-build", versionMatch: true },
      { env },
    );
    recordUpdateGatewayHealth(
      run,
      {
        runtime: { status: "running", pid: 12345 },
        portUsage: { port: 19123, status: "busy", listeners: [], hints: [] },
        healthy: false,
        staleGatewayPids: [],
        expectedVersion: "2026.9.4",
        gatewayVersion,
      },
      19123,
    );
    const recorded = finishUpdateRun(
      run.runId,
      {
        status: "failed",
        reason: "restart-unhealthy",
        after: { version: "2026.9.4" },
      },
      { env },
    );
    if (!recorded) {
      throw new Error("Missing finished update record");
    }
    expect(recorded.verification.runningVersion).toBe(gatewayVersion);
    expect(recorded.verification.runningBuildId).toBeUndefined();
    expect(recorded.verification.versionMatch).toBe(
      gatewayVersion === undefined ? undefined : gatewayVersion === "2026.9.4",
    );
    expect(renderUpdateRunReport(recorded).markdown.includes("version mismatch")).toBe(
      gatewayVersion === "2026.9.2",
    );
  },
);
