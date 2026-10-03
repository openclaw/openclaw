import { describe, expect, it } from "vitest";
import { markPackagePostInstallDoctorAdvisory } from "./package-update-verification-step.js";
import {
  createDeferredConfiguredPluginRepairDoctorResult,
  UPDATE_POST_INSTALL_DOCTOR_ADVISORY_EXIT_CODE,
} from "./update-doctor-result.js";

describe("markPackagePostInstallDoctorAdvisory", () => {
  it.each([0, UPDATE_POST_INSTALL_DOCTOR_ADVISORY_EXIT_CODE])(
    "retains specific Doctor warnings on normal exit %s",
    (exitCode) => {
      const warning =
        "Skipped derived cache cleanup: permission denied. Run openclaw doctor --fix.";
      const result =
        exitCode === 0
          ? { status: "ok" as const, warnings: [warning] }
          : {
              ...createDeferredConfiguredPluginRepairDoctorResult(["deferred plugin repair"]),
              warnings: [warning],
            };
      const step = markPackagePostInstallDoctorAdvisory(
        { exitCode, termination: "exit" as const, stderrTail: "doctor diagnostics" },
        result,
      );
      expect(step.advisory).toMatchObject({
        kind: "package-post-install-doctor",
        message: expect.stringContaining("recoverable update-time repair warning"),
      });
      expect(step.advisory?.message).toContain(warning);
      expect(step.stderrTail).toContain("doctor diagnostics");
      if (exitCode === UPDATE_POST_INSTALL_DOCTOR_ADVISORY_EXIT_CODE) {
        expect(step.stderrTail).toContain("deferred plugin repair");
      }
      expect(step).toMatchObject({
        warnings: [
          warning,
          ...(exitCode === UPDATE_POST_INSTALL_DOCTOR_ADVISORY_EXIT_CODE
            ? ["deferred plugin repair\nRun openclaw doctor --fix to finish deferred repairs."]
            : []),
        ],
      });
    },
  );
  it("keeps advisory diagnostics bounded after appending deferred repair details", () => {
    const step = markPackagePostInstallDoctorAdvisory(
      {
        exitCode: UPDATE_POST_INSTALL_DOCTOR_ADVISORY_EXIT_CODE,
        stderrTail: "doctor deferred repair",
        signal: null,
        killed: false,
        termination: "exit" as const,
      },
      createDeferredConfiguredPluginRepairDoctorResult([
        `deferred configured plugin repair ${"x".repeat(10_000)}`,
      ]),
    );

    expect(step.stderrTail).toHaveLength(8_001);
    expect(step.stderrTail).toMatch(/^…/u);
    expect(step.stderrTail).toContain("recoverable update-time repair warning");
    expect(step.warnings).toEqual([
      `${`deferred configured plugin repair ${"x".repeat(10_000)}`.slice(0, 500)}\nRun openclaw doctor --fix to finish deferred repairs.`,
    ]);
  });

  it("preserves failed Doctor diagnostics when no receipt is available", () => {
    const step = markPackagePostInstallDoctorAdvisory(
      {
        exitCode: 1,
        stderrTail: "doctor refused migration",
        signal: null,
        killed: false,
        termination: "exit" as const,
      },
      null,
    );

    expect(step.advisory).toBeUndefined();
    expect(step.stderrTail).toBe("doctor refused migration");
  });

  it("does not mark timed-out doctor exits as advisory even with the advisory code", () => {
    const step = markPackagePostInstallDoctorAdvisory(
      {
        exitCode: UPDATE_POST_INSTALL_DOCTOR_ADVISORY_EXIT_CODE,
        stderrTail: "doctor timed out",
        signal: null,
        killed: false,
        termination: "timeout" as const,
      },
      createDeferredConfiguredPluginRepairDoctorResult(["deferred configured plugin repair"]),
    );

    expect(step.advisory).toBeUndefined();
    expect(step.stderrTail).toBe("doctor timed out");
  });
});
