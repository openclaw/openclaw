import { expect, it, vi } from "vitest";
import { withTempHomeConfig } from "../config/test-helpers.js";
import * as contributions from "../flows/doctor-health-contributions.js";
import { clearHealthChecksForTest, registerHealthCheck } from "../flows/health-check-registry.js";
import { runDoctorLintCli } from "./doctor-lint.js";
import { createTestRuntime } from "./test-runtime-config-helpers.js";

it.each([false, true])(
  "retains below-threshold warnings only for an update parent (%s)",
  async (update) => {
    await withTempHomeConfig({}, async () => {
      // The published canary clears IN_PROGRESS for lint but keeps this parent marker.
      vi.stubEnv("OPENCLAW_UPDATE_IN_PROGRESS", "0");
      vi.stubEnv("OPENCLAW_UPDATE_POST_CORE_CONVERGENCE", "0");
      vi.stubEnv("OPENCLAW_UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE", update ? "1" : "0");
      const finding = {
        checkId: "plugin/example/posture",
        severity: "warning" as const,
        message: "Open group policy permits mention-gated requests.",
      };
      clearHealthChecksForTest();
      registerHealthCheck({
        id: finding.checkId,
        kind: "plugin",
        description: "Posture advisory",
        async detect() {
          return [finding];
        },
      });
      const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      try {
        const runtime = createTestRuntime();
        expect(
          await runDoctorLintCli(runtime, {
            json: true,
            severityMin: "error",
            onlyIds: [finding.checkId],
          }),
        ).toBe(0);
        const payload = JSON.parse(String(stdout.mock.calls.at(-1)?.[0]));
        expect(payload.findings).toEqual([]);
        expect(payload.warnings).toEqual(update ? [finding] : undefined);
      } finally {
        stdout.mockRestore();
        clearHealthChecksForTest();
        vi.unstubAllEnvs();
      }
    });
  },
);

it.each(
  ["security", "runtime-tool-schemas", "final-config-validation"].flatMap((check) =>
    [false, true].map((update) => ({ check, update })),
  ),
)(
  "uses the existing update work classification for $check (update: $update)",
  async ({ check, update }) => {
    await withTempHomeConfig({}, async () => {
      clearHealthChecksForTest();
      vi.stubEnv("OPENCLAW_UPDATE_IN_PROGRESS", "0");
      vi.stubEnv("OPENCLAW_UPDATE_POST_CORE_CONVERGENCE", "0");
      vi.stubEnv("OPENCLAW_UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE", update ? "1" : "0");
      const checkId = `core/doctor/${check}`;
      const finding = {
        checkId,
        severity: "error" as const,
        message: "Synthetic detector finding.",
      };
      const checks = await contributions.resolveDoctorContributionHealthChecks();
      const selected = checks.find((entry) => entry.id === checkId);
      expect(selected).toBeDefined();
      const resolve = vi
        .spyOn(contributions, "resolveDoctorContributionHealthChecks")
        .mockResolvedValue([{ ...selected!, detect: async () => [finding] }]);
      const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      try {
        const advisory = update && check !== "final-config-validation";
        const exitCode = await runDoctorLintCli(createTestRuntime(), {
          json: true,
          severityMin: "error",
          onlyIds: [checkId],
        });
        const payload = JSON.parse(String(stdout.mock.calls.at(-1)?.[0]));
        expect(exitCode).toBe(advisory ? 0 : 1);
        expect(payload.findings).toEqual(advisory ? [] : [finding]);
        expect(payload.warnings).toEqual(
          advisory ? [{ ...finding, severity: "warning" }] : undefined,
        );
        if (update) {
          expect(stderr.mock.calls.flat().join("")).toContain(
            `Doctor lint ${advisory ? "warning" : "error"} [${checkId}]: Synthetic detector finding.`,
          );
        } else {
          expect(stderr.mock.calls.flat().join("")).not.toContain("Doctor lint ");
        }
      } finally {
        resolve.mockRestore();
        stdout.mockRestore();
        stderr.mockRestore();
        clearHealthChecksForTest();
        vi.unstubAllEnvs();
      }
    });
  },
);
