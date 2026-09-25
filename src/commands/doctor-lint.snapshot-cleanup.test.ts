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
    async prepareSqliteReadOnlyLocation(
      ...args: Parameters<typeof actual.prepareSqliteReadOnlyLocation>
    ) {
      const prepared = await actual.prepareSqliteReadOnlyLocation(...args);
      return {
        ...prepared,
        cleanupAsync: vi
          .fn()
          .mockRejectedValueOnce(new Error("SQLite read-only worker snapshot cleanup failed"))
          .mockImplementation(prepared.cleanupAsync),
      };
    },
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
  { update: true, blocking: true, all: true },
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

it.each(["json", "human"] as const)(
  "preserves invalid-config failure and cleanup warnings in %s output",
  async (mode) => {
    await withOpenClawTestState(
      {
        prefix: "doctor-lint-invalid-cleanup-",
        env: {
          OPENCLAW_UPDATE_IN_PROGRESS: "1",
          OPENCLAW_UPDATE_POST_CORE_CONVERGENCE: "1",
        },
      },
      async (state) => {
        await state.writeConfig({ gateway: { mode: "fixture-invalid-mode" } });
        openOpenClawStateDatabase({ env: state.env });
        await closeOpenClawStateDatabaseAsync();
        const runtime = createTestRuntime();
        const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
        const tty = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
        Object.defineProperty(process.stdout, "isTTY", {
          configurable: true,
          value: mode === "human",
        });
        try {
          const exitCode = await runDoctorLintCli(runtime, {
            json: mode === "json",
            severityMin: "error",
          });
          expect(exitCode).toBe(1);
          if (mode === "json") {
            const report = JSON.parse(String(stdout.mock.calls.at(-1)?.[0]));
            expect(report.ok).toBe(false);
            expect(report.findings).toContainEqual(
              expect.objectContaining({
                checkId: "core/doctor/final-config-validation",
                severity: "error",
                path: "gateway.mode",
              }),
            );
            expect(report.warnings).toContainEqual(
              expect.objectContaining({
                checkId: "core/doctor/lint-state-inspection",
                severity: "warning",
                requirement: "temporary-snapshot-cleanup",
              }),
            );
          } else {
            expect(runtime.error).toHaveBeenCalledWith(
              "doctor --lint: config file exists but does not parse cleanly.",
            );
            expect(runtime.error).toHaveBeenCalledWith(expect.stringContaining("gateway.mode"));
            expect(runtime.error).toHaveBeenCalledWith(
              expect.stringContaining(
                "Temporary doctor lint state snapshot cleanup did not complete.",
              ),
            );
          }
        } finally {
          if (tty) {
            Object.defineProperty(process.stdout, "isTTY", tty);
          } else {
            Reflect.deleteProperty(process.stdout, "isTTY");
          }
        }
      },
    );
  },
);

it.each(["json", "human"] as const)(
  "preserves detector failures when ordinary snapshot cleanup fails in %s output",
  async (mode) => {
    await withOpenClawTestState(
      {
        prefix: "doctor-lint-detector-cleanup-",
        env: {
          OPENCLAW_UPDATE_IN_PROGRESS: "0",
          OPENCLAW_UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE: "0",
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
        const detect = vi.fn(async () => {
          throw new Error("Authoritative detector fixture failure.");
        });
        mocks.checks.mockResolvedValue([
          {
            id: "core/doctor/runtime-tool-schemas",
            kind: "core",
            description: "ordinary detector and snapshot cleanup failure regression",
            detect,
          },
        ]);
        const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
        const tty = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
        Object.defineProperty(process.stdout, "isTTY", {
          configurable: true,
          value: mode === "human",
        });
        try {
          const exitCode = await runDoctorLintCli(createTestRuntime(), {
            json: mode === "json",
            severityMin: "error",
            onlyIds: ["core/doctor/runtime-tool-schemas"],
          });
          expect(detect).toHaveBeenCalledOnce();
          expect(exitCode).toBe(1);
          if (mode === "json") {
            const report = JSON.parse(String(stdout.mock.calls.at(-1)?.[0]));
            expect(report.ok).toBe(false);
            expect(report.findings).toContainEqual(
              expect.objectContaining({
                checkId: "core/doctor/runtime-tool-schemas",
                severity: "error",
                message: expect.stringContaining("Authoritative detector fixture failure."),
              }),
            );
            expect(report.findings).toContainEqual(
              expect.objectContaining({
                message: expect.stringContaining("snapshot cleanup did not complete"),
              }),
            );
          } else {
            const output = stdout.mock.calls.map(([chunk]) => String(chunk)).join("");
            expect(output).toContain("[error] core/doctor/runtime-tool-schemas");
            expect(output).toContain("Authoritative detector fixture failure.");
            expect(output).toContain("snapshot cleanup did not complete");
          }
        } finally {
          if (tty) {
            Object.defineProperty(process.stdout, "isTTY", tty);
          } else {
            Reflect.deleteProperty(process.stdout, "isTTY");
          }
        }
      },
    );
  },
);
