import { expect, it, vi } from "vitest";
import { withTempHomeConfig } from "../config/test-helpers.js";
import * as contributions from "../flows/doctor-health-contributions.js";
import { clearHealthChecksForTest } from "../flows/health-check-registry.js";
import { runDoctorLintCli } from "./doctor-lint.js";
import { createTestRuntime } from "./test-runtime-config-helpers.js";

it("keeps runtime tool schema findings advisory during updates", async () => {
  await withTempHomeConfig({}, async () => {
    clearHealthChecksForTest();
    vi.stubEnv("OPENCLAW_UPDATE_IN_PROGRESS", "0");
    vi.stubEnv("OPENCLAW_UPDATE_POST_CORE_CONVERGENCE", "0");
    vi.stubEnv("OPENCLAW_UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE", "1");
    const checkId = "core/doctor/runtime-tool-schemas";
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
      const payload = JSON.parse(String(stdout.mock.calls.at(-1)?.[0]));
      expect(exitCode).toBe(0);
      expect(payload.findings).toEqual([]);
      expect(payload.warnings).toEqual([{ ...finding, severity: "warning" }]);
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
