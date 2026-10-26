import { expect, it } from "vitest";
import {
  deferPackageStateVerification,
  markPackagePostInstallDoctorAdvisory,
  runPackagePostInstallVerification,
} from "./package-update-verification-step.js";
import { SqliteSchemaVersionError } from "./sqlite-user-version.js";
import {
  createDeferredConfiguredPluginRepairDoctorResult,
  UPDATE_POST_INSTALL_DOCTOR_ADVISORY_EXIT_CODE as advisoryExitCode,
} from "./update-doctor-result.js";
import { isFailedUpdateStep } from "./update-run-step.js";

function doctorStep(
  exitCode: number,
  stderrTail: string,
  termination: "exit" | "timeout" = "exit",
) {
  return { exitCode, stderrTail, termination, signal: null, killed: false };
}
const deferred = createDeferredConfiguredPluginRepairDoctorResult(["deferred plugin repair"]);
it.each([
  [0, { status: "ok" as const }, []],
  [
    advisoryExitCode,
    deferred,
    ["deferred plugin repair\nRun openclaw doctor --fix to finish deferred repairs."],
  ],
] as const)(
  "retains specific Doctor warnings on normal exit %s",
  (exitCode, result, deferredWarnings) => {
    const warning = "Skipped derived cache cleanup: permission denied. Run openclaw doctor --fix.";
    const step = markPackagePostInstallDoctorAdvisory(
      { exitCode, termination: "exit" as const, stderrTail: "doctor diagnostics" },
      { ...result, warnings: [warning] },
    );
    expect(step.advisory).toMatchObject({
      kind: "package-post-install-doctor",
      message: expect.stringContaining("recoverable update-time repair warning"),
    });
    expect(step.advisory?.message).toContain(warning);
    expect(step.stderrTail).toContain("doctor diagnostics");
    if (exitCode === advisoryExitCode) {
      expect(step.stderrTail).toContain("deferred plugin repair");
    }
    expect(step.warnings).toEqual([warning, ...deferredWarnings]);
  },
);
it("keeps advisory diagnostics bounded after appending deferred repair details", () => {
  const step = markPackagePostInstallDoctorAdvisory(
    doctorStep(advisoryExitCode, "doctor deferred repair"),
    createDeferredConfiguredPluginRepairDoctorResult([
      `Deferred configured plugin repair. ${"x".repeat(10_000)}`,
    ]),
  );

  expect(step.stderrTail).toHaveLength(8_001);
  expect(step.stderrTail).toMatch(/^…/u);
  expect(step.stderrTail).toContain("recoverable update-time repair warning");
  expect(step.warnings).toEqual([
    "Deferred configured plugin repair. …\nRun openclaw doctor --fix to finish deferred repairs.",
  ]);
});

it.each([
  [doctorStep(1, "doctor refused migration"), null],
  [
    doctorStep(advisoryExitCode, "doctor timed out", "timeout"),
    createDeferredConfiguredPluginRepairDoctorResult(["deferred configured plugin repair"]),
  ],
] as const)("preserves non-advisory diagnostics: %j", (original, receipt) => {
  const step = markPackagePostInstallDoctorAdvisory(original, receipt);

  expect(step.advisory).toBeUndefined();
  expect(step.stderrTail).toBe(original.stderrTail);
});

it.each([false, true])(
  "treats a newer-schema refusal as advisory only after recorded candidate migration (%s)",
  async (migrationRecorded) => {
    const root = "/candidate/openclaw";
    const params = { root, migrationRecorded, progress: undefined, assertCurrent: () => {} };
    const step = await runPackagePostInstallVerification(root, async (_root, results) =>
      deferPackageStateVerification(
        { ...params, results },
        new Error("Cannot read shared state for discovery", {
          cause: new SqliteSchemaVersionError("State uses a newer schema version."),
        }),
      ),
    );
    expect(isFailedUpdateStep(step)).toBe(!migrationRecorded);
    if (migrationRecorded) {
      expect(step.advisory).toMatchObject({
        kind: "recoverable-maintenance",
        message: expect.stringContaining("candidate migration"),
      });
      expect(step.failureFacts).toBeUndefined();
    } else {
      expect(step.failureFacts).toEqual([
        expect.objectContaining({ check: "package-runtime", code: "runtime-verification-failed" }),
      ]);
    }
  },
);
