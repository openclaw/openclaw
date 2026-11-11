import { expect, it } from "vitest";
import {
  deferPackageStateVerification,
  markPackagePostInstallDoctorAdvisory as markAdvisory,
  runPackagePostInstallVerification as verify,
} from "./package-update-verification-step.js";
import { SqliteSchemaVersionError } from "./sqlite-user-version.js";
import {
  createDeferredConfiguredPluginRepairDoctorResult as deferred,
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
const repair = "deferred plugin repair";
const guidance = "Run openclaw doctor --fix to finish deferred repairs.";

it.each([0, advisoryExitCode])("retains specific Doctor warnings on normal exit %s", (exitCode) => {
  const warning = "Skipped derived cache cleanup: permission denied.";
  const result = exitCode ? deferred([repair]) : { status: "ok" as const };
  const step = markAdvisory(doctorStep(exitCode, "doctor diagnostics"), {
    ...result,
    warnings: [warning],
  });
  expect(step.advisory?.kind).toBe("package-post-install-doctor");
  expect(step.advisory?.message).toContain(warning);
  expect(step.stderrTail).toContain("doctor diagnostics");
  if (exitCode) {
    expect(step.stderrTail).toContain(repair);
  }
  expect(step.warnings).toEqual(exitCode ? [warning, `${repair}\n${guidance}`] : [warning]);
});

it("keeps advisory diagnostics bounded after appending deferred repair details", () => {
  const step = markAdvisory(
    doctorStep(advisoryExitCode, "doctor deferred repair"),
    deferred([`Deferred configured plugin repair. ${"x".repeat(10_000)}`]),
  );
  expect(step.stderrTail).toHaveLength(8_001);
  expect(step.stderrTail).toMatch(/^…/u);
  expect(step.stderrTail).toContain("recoverable update-time repair warning");
  expect(step.warnings).toEqual([`Deferred configured plugin repair. …\n${guidance}`]);
});

it.each([
  [doctorStep(1, "doctor refused migration"), null],
  [doctorStep(advisoryExitCode, "doctor timed out", "timeout"), deferred([repair])],
] as const)("preserves non-advisory diagnostics: %j", (original, receipt) => {
  const step = markAdvisory(original, receipt);
  expect([step.advisory, step.stderrTail]).toEqual([undefined, original.stderrTail]);
});

it.each([false, true])(
  "requires recorded candidate migration for newer-schema advice (%s)",
  async (migrationRecorded) => {
    const root = "/candidate/openclaw";
    const step = await verify(root, async (_root, results) =>
      deferPackageStateVerification(
        { root, migrationRecorded, results, progress: undefined, assertCurrent() {} },
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
