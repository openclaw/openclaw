import { expect, it, vi } from "vitest";
import { withTempHomeConfig } from "../config/test-helpers.js";
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
