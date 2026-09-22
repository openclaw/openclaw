import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  createUpdateRun,
  finishUpdateRun,
  recordUpdateRunVerification,
} from "../../infra/update-run-ledger.js";
import { renderUpdateRunReport } from "../../infra/update-run-report.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { recordUpdateGatewayHealth } from "./update-command-verification.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => closeOpenClawStateDatabaseForTest());

it("does not reuse an earlier runtime identity when the next verification cannot read it", () => {
  const env = { ...process.env, OPENCLAW_STATE_DIR: tempDirs.make("update-identity-unavailable-") };
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
  expect(recorded.verification.runningVersion).toBeUndefined();
  expect(recorded.verification.runningBuildId).toBeUndefined();
  expect(renderUpdateRunReport(recorded).markdown).toContain("service identity unavailable");
  expect(renderUpdateRunReport(recorded).markdown).not.toContain("version mismatch");
});
