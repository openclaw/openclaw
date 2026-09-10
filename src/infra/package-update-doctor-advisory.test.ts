import { describe, expect, it } from "vitest";
import { markPackagePostInstallDoctorAdvisory } from "./package-update-steps.js";
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
        { exitCode, termination: "exit" as const },
        result,
      );
      expect(step.advisory?.message).toContain(warning);
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
  it("marks only explicit post-install doctor advisory exits", () => {
    const step = markPackagePostInstallDoctorAdvisory(
      {
        exitCode: UPDATE_POST_INSTALL_DOCTOR_ADVISORY_EXIT_CODE,
        stderrTail: "doctor deferred repair",
        signal: null,
        killed: false,
        termination: "exit" as const,
      },
      createDeferredConfiguredPluginRepairDoctorResult(["deferred configured plugin repair"]),
    );

    expect(step.advisory).toEqual({
      kind: "package-post-install-doctor",
      message: expect.stringContaining("recoverable update-time repair warning"),
    });
    expect(step).toMatchObject({
      warnings: [
        "deferred configured plugin repair\nRun openclaw doctor --fix to finish deferred repairs.",
      ],
    });
    expect(step.stderrTail).toContain("doctor deferred repair");
    expect(step.stderrTail).toContain("deferred configured plugin repair");
  });

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

  it("does not mark unknown nonzero doctor exits as advisory", () => {
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

  it("does not mark timed-out doctor exits as advisory when they report a code", () => {
    const step = markPackagePostInstallDoctorAdvisory(
      {
        exitCode: 124,
        stderrTail: "doctor timed out",
        signal: null,
        killed: true,
        termination: "timeout" as const,
      },
      createDeferredConfiguredPluginRepairDoctorResult(["deferred configured plugin repair"]),
    );

    expect(step.advisory).toBeUndefined();
    expect(step.stderrTail).toBe("doctor timed out");
  });
});
