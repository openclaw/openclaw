import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  createUpdateRun,
  finishUpdateRun,
  getUpdateRun,
  recordUpdateRunVerification,
} from "../../infra/update-run-ledger.js";
import { renderUpdateRunReport } from "../../infra/update-run-report.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import type { GatewayRestartSnapshot } from "../daemon-cli/restart-health.js";
import type { UpdateCommandOptions } from "./shared.js";
import { observeUpdateGatewayReadiness } from "./update-command-readiness.js";
import { verifyUpdatedGateway } from "./update-command-verification.js";

vi.mock("./update-command-readiness.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./update-command-readiness.js")>()),
  observeUpdateGatewayReadiness: vi.fn(),
}));

async function verifyObservation(
  run: NonNullable<UpdateCommandOptions["run"]>,
  health: Partial<GatewayRestartSnapshot>,
  readyz = false,
) {
  vi.mocked(observeUpdateGatewayReadiness).mockResolvedValue({
    health: {
      runtime: { status: "running", pid: 12345 },
      portUsage: { port: 19123, status: "busy", listeners: [], hints: [] },
      healthy: false,
      staleGatewayPids: [],
      expectedVersion: "2026.9.4",
      ...health,
    },
    readyz,
    http: undefined,
    launchAgentRecovery: null,
  });
  return await verifyUpdatedGateway({
    result: { status: "ok", mode: "npm", steps: [], durationMs: 0 },
    opts: { json: true, run },
    serviceEnv: run.env ?? {},
    gatewayPort: 19123,
  });
}

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => closeOpenClawStateDatabaseForTest());
function createRun() {
  const env = { ...process.env, OPENCLAW_STATE_DIR: tempDirs.make("update-verification-") };
  return { runId: createUpdateRun({ trigger: "cli" }, { env }).runId, env };
}

it.each([undefined, "2026.9.2", "2026.9.4"])(
  "reports only the currently observed version during startup (%s)",
  async (gatewayVersion) => {
    const run = createRun();
    const { env } = run;
    recordUpdateRunVerification(
      run.runId,
      { runningVersion: "2026.9.2", runningBuildId: "previous-build", versionMatch: true },
      { env },
    );
    expect((await verifyObservation(run, { gatewayVersion })).ok).toBe(false);
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
    const report = renderUpdateRunReport(recorded).markdown;
    expect(report.includes("version mismatch")).toBe(gatewayVersion === "2026.9.2");
    expect(report).toContain("Gateway readiness was not verified; service status: running");
    expect(report).toContain("openclaw gateway status --deep");
  },
);

it("records HTTP-verified activation as success with an authentication warning", async () => {
  const run = createRun();
  const { env } = run;
  const verified = await verifyObservation(
    run,
    {
      healthy: true,
      expectedVersion: "2026.10.4",
      gatewayVersion: "2026.10.4",
      authenticationError: "device identity required",
    },
    true,
  );
  expect(verified.ok).toBe(true);
  const observed = getUpdateRun(run.runId, { env });
  expect(observed?.verification).toMatchObject({
    runningVersion: "2026.10.4",
    versionMatch: true,
    readyz: true,
    settled: true,
  });
  expect(observed?.steps.find((step) => step.step === "gateway verification")).toMatchObject({
    status: "completed",
  });
  expect(
    observed?.steps.find((step) => step.step === "warning:gateway verification"),
  ).toMatchObject({
    status: "completed",
    detail: expect.stringContaining("device identity required"),
  });
});
