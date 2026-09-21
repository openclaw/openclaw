import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { clearHealthChecksForTest } from "../flows/health-check-registry.js";
import { buildUpdateRehearsalPathEnv } from "../infra/update-rehearsal-paths.js";
import { createUpdateRun, recordUpdateRunPhase } from "../infra/update-run-ledger.js";
import { buildUpdateDoctorEnv } from "../infra/update-runner-doctor.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { runDoctorLintCli } from "./doctor-lint.js";
import { createTestRuntime } from "./test-runtime-config-helpers.js";

const observed = vi.hoisted(() => ({ now: 0 }));
vi.mock("../flows/doctor-health-contributions.js", () => ({
  resolveDoctorContributionHealthChecks: async () => [],
}));
vi.mock("../flows/bundled-health-checks.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../flows/bundled-health-checks.js")>();
  const { registerHealthCheck } = await import("../flows/health-check-registry.js");
  return {
    ...actual,
    registerBundledHealthChecks({ cfg }: { cfg: OpenClawConfig }) {
      // Charge synchronous plugin preparation without delaying the test process.
      observed.now += Object.keys(cfg.agents?.entries ?? {}).length * 1_000;
      registerHealthCheck({
        id: "fixture/fleet-inspection",
        kind: "plugin",
        description: "Synthetic fleet inspection",
        detect: async () => [
          {
            checkId: "fixture/fleet-inspection",
            severity: "warning",
            message: "Synthetic optional plugin diagnostic.",
          },
        ],
      });
      return [];
    },
  };
});

beforeEach(() => clearHealthChecksForTest());
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  clearHealthChecksForTest();
});

it.each([3, 480])(
  "keeps published-driver lint within budget and reports deferred work for %i agents",
  async (agentCount) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const cfg: OpenClawConfig = {
        agents: {
          ownership: "explicit",
          entries: Object.fromEntries(
            Array.from({ length: agentCount }, (_, index) => [`fleet-${index}`, {}]),
          ),
        },
        plugins: { enabled: false },
      };
      await state.writeConfig(cfg);
      const env = {
        ...state.env,
        ...buildUpdateRehearsalPathEnv(state.stateDir),
        ...buildUpdateDoctorEnv({
          allowGatewayServiceRepair: false,
          allowGatewayActivation: false,
          serviceRepairPolicy: "external",
          deferConfiguredPluginInstallRepair: true,
        }),
        OPENCLAW_UPDATE_IN_PROGRESS: "0",
        OPENCLAW_COMPATIBILITY_HOST_VERSION: undefined,
        OPENCLAW_UPDATE_POST_CORE_CONVERGENCE: undefined,
      };
      const startedAt = Date.now();
      const run = createUpdateRun(
        { trigger: "cli", target: { kind: "package" }, before: { version: "2026.9.4" } },
        { env },
      );
      recordUpdateRunPhase(run.runId, "validating", {}, { env });
      closeOpenClawStateDatabaseForTest();
      for (const [key, value] of Object.entries(env)) {
        if (value !== process.env[key]) {
          vi.stubEnv(key, value);
        }
      }
      observed.now = startedAt + 20_000;
      vi.spyOn(Date, "now").mockImplementation(() => observed.now);
      const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
      try {
        const exitCode = await runDoctorLintCli(createTestRuntime(), {
          json: true,
          severityMin: "error",
        });
        const report = JSON.parse(String(stdout.mock.calls.at(-1)?.[0]));

        expect(exitCode, JSON.stringify(report)).toBe(0);
        expect(report).toMatchObject({ ok: true, findings: [] });
        expect(observed.now - startedAt).toBeLessThan(298_000);
        expect(report.checksRun).toBe(agentCount === 3 ? 1 : 0);
        expect(report.warnings).toEqual([
          agentCount === 3
            ? {
                checkId: "fixture/fleet-inspection",
                severity: "warning",
                message: "Synthetic optional plugin diagnostic.",
              }
            : expect.objectContaining({
                checkId: "core/doctor/lint-inspection",
                severity: "warning",
                errorCode: "update-inspection-deferred",
                requirement: "update-validation-budget",
                fixHint: expect.stringContaining("openclaw doctor"),
              }),
        ]);
      } finally {
        stdout.mockRestore();
        vi.restoreAllMocks();
        vi.unstubAllEnvs();
      }
    });
  },
);
