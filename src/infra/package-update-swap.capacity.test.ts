import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { captureSwap, expectInstallation } from "./package-update-swap.assertions.test-support.js";
import { createPackageSwapFixture } from "./package-update-swap.test-support.js";
import {
  createUpdateStateInspectionDiagnostics,
  formatUpdateStateInspectionError,
} from "./update-candidate-state.diagnostics.js";
import { UpdateCaptureSpaceError } from "./update-capture-space.js";
import { prepareUpdateFailureReport } from "./update-failure-report-prepare.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);

it("reports a worker's disk refusal and verifies the unchanged package for recovery", async () => {
  const base = dirs.make("swap-capacity-");
  const { params, packageRoot, launcher } = await createPackageSwapFixture(base);
  const diagnostics = createUpdateStateInspectionDiagnostics({
    operation: "State schema inspection",
    phase: "database backup",
    paths: [base],
  });
  diagnostics.onOutputChunk(
    Buffer.from(
      formatUpdateStateInspectionError(
        new UpdateCaptureSpaceError(`Backup refused near ${base}`, {
          requiredBytes: 9126805504,
          availableBytes: 8375186227,
          volume: "backup",
        }),
      ),
    ),
    "stderr",
  );
  const { result, transaction } = await captureSwap({
    ...params,
    onTransaction: () => {
      throw diagnostics.failure(diagnostics.stderr(), "exit");
    },
  });
  expect(result.status).toBe("failed");
  const report = await prepareUpdateFailureReport(
    {
      attemptId: "disk-refusal",
      result: { mode: "pnpm", status: "error", durationMs: 0, steps: [result.step] },
    },
    { env: {}, stateDir: base },
  );
  expect(report.body).toContain("Update database backup volume: needs 8.5 GiB; available 7.8 GiB");
  expect(report.body).not.toContain(base);
  expect(await transaction.rollback(() => {})).toMatchObject({
    exitCode: 0,
    activePackageRoot: packageRoot,
  });
  await expectInstallation(packageRoot, launcher);
  expect(await transaction.complete({ activationVerified: false }, () => {})).toBeUndefined();
});
