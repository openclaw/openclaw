import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { clearHealthChecksForTest } from "../flows/health-check-registry.js";
import type { HealthFinding } from "../flows/health-checks.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { runDoctorLintCli } from "./doctor-lint.js";
import { createTestRuntime } from "./test-runtime-config-helpers.js";

const mocks = vi.hoisted(() => ({ checks: vi.fn() }));
vi.mock("../flows/doctor-health-contributions.js", () => ({
  resolveDoctorContributionHealthChecks: mocks.checks,
}));
vi.mock("../infra/sqlite-snapshot-source.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../infra/sqlite-snapshot-source.js")>();
  return {
    ...actual,
    prepareSqliteReadOnlyLocationSync(pathname: string) {
      const prepared = actual.prepareSqliteReadOnlyLocationSync(pathname);
      return {
        ...prepared,
        async cleanupAsync() {
          await prepared.cleanupAsync();
          return false;
        },
      };
    },
  };
});

beforeEach(() => clearHealthChecksForTest());

afterEach(async () => {
  vi.restoreAllMocks();
  await closeOpenClawStateDatabaseAsync();
});

it.each([
  { update: false, blocking: false, all: false },
  { update: true, blocking: false, all: false },
  { update: true, blocking: true, all: false },
  { update: true, blocking: false, all: true },
])(
  "keeps snapshot cleanup diagnostic separate during lint (%j)",
  async ({ update, blocking, all }) => {
    await withOpenClawTestState(
      {
        prefix: "doctor-lint-cleanup-gate-",
        env: {
          OPENCLAW_UPDATE_IN_PROGRESS: "0",
          OPENCLAW_UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE: update ? "1" : "0",
          OPENCLAW_UPDATE_POST_CORE_CONVERGENCE: "0",
        },
      },
      async (state) => {
        await state.writeConfig({
          gateway: { mode: "local" },
          memory: { search: { enabled: false } },
        });
        openOpenClawStateDatabase({ env: state.env });
        await closeOpenClawStateDatabaseAsync();
        const finding: HealthFinding = {
          checkId: "core/doctor/runtime-tool-schemas",
          severity: "error",
          message: "Runtime tool schema is invalid.",
        };
        mocks.checks.mockResolvedValue([
          {
            id: finding.checkId,
            kind: "core",
            description: "snapshot cleanup gate regression",
            detect: async () => (blocking ? [finding] : []),
          },
        ]);
        const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
        const exitCode = await runDoctorLintCli(createTestRuntime(), {
          json: true,
          severityMin: "error",
          ...(all ? { includeAllChecks: true } : { onlyIds: [finding.checkId] }),
        });
        const report = JSON.parse(String(stdout.mock.calls.at(-1)?.[0]));
        expect(exitCode).toBe(update && !blocking ? 0 : 1);
        expect(report.ok).toBe(update && !blocking);
        if (update) {
          expect(report.findings).toEqual(blocking ? [finding] : []);
          expect(report.checksRun).toBeGreaterThan(0);
          expect(report.warnings).toContainEqual(
            expect.objectContaining({
              severity: "warning",
              message: expect.stringContaining("snapshot cleanup did not complete"),
            }),
          );
        } else {
          expect(report.findings).toContainEqual(
            expect.objectContaining({
              severity: "error",
              message: expect.stringContaining("snapshot cleanup did not complete"),
            }),
          );
        }
      },
    );
  },
);
