import { expect, it, vi } from "vitest";
import { withTempHomeConfig } from "../config/test-helpers.js";
import * as contributions from "../flows/doctor-health-contributions.js";
import { clearHealthChecksForTest } from "../flows/health-check-registry.js";
import { parseReleasedDoctorLintReport } from "../infra/test-fixtures/update-doctor-lint.v2026-9-5.js";
import { runDoctorLintCli } from "./doctor-lint.js";
import { createTestRuntime } from "./test-runtime-config-helpers.js";

it.each([
  {
    driver: "writable update parent",
    checkId: "core/doctor/runtime-tool-schemas",
    releasedPostPlugin: false,
  },
  {
    driver: "released post-plugin updater",
    checkId: "core/doctor/security",
    releasedPostPlugin: true,
  },
])("keeps inspection findings advisory for a $driver", async ({ checkId, releasedPostPlugin }) => {
  await withTempHomeConfig({}, async () => {
    clearHealthChecksForTest();
    // Released 9.4/9.5 updaters lack the writable-parent marker and use both phase markers.
    vi.stubEnv("OPENCLAW_UPDATE_IN_PROGRESS", releasedPostPlugin ? "1" : "0");
    vi.stubEnv("OPENCLAW_UPDATE_POST_CORE_CONVERGENCE", releasedPostPlugin ? "1" : "0");
    vi.stubEnv(
      "OPENCLAW_UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE",
      releasedPostPlugin ? "0" : "1",
    );
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
      const exitCode = await runDoctorLintCli(createTestRuntime(), {
        json: true,
        severityMin: "error",
        onlyIds: [checkId],
      });
      const output = String(stdout.mock.calls.at(-1)?.[0]);
      const payload = JSON.parse(output);
      expect(exitCode).toBe(0);
      expect(payload.findings).toEqual([]);
      expect(payload.warnings).toEqual([{ ...finding, severity: "warning" }]);
      if (releasedPostPlugin) {
        expect(parseReleasedDoctorLintReport(output)).toMatchObject({
          ok: true,
          findings: [],
          warnings: [{ ...finding, severity: "warning" }],
        });
      }
      expect(stderr.mock.calls.flat().join("")).toContain(
        `Doctor lint warning [${checkId}]: Synthetic detector finding.`,
      );
    } finally {
      resolve.mockRestore();
      stdout.mockRestore();
      stderr.mockRestore();
      clearHealthChecksForTest();
      vi.unstubAllEnvs();
    }
  });
});
