import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { clearHealthChecksForTest } from "../flows/health-check-registry.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import type { DoctorLintCliOptions } from "./doctor-lint-options.js";
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

async function runCleanupLint(
  options: DoctorLintCliOptions,
  env: NodeJS.ProcessEnv,
  config: unknown = { gateway: { mode: "local" }, memory: { search: { enabled: false } } },
) {
  return withOpenClawTestState({ prefix: "doctor-lint-cleanup-", env }, async (state) => {
    await state.writeConfig(config);
    openOpenClawStateDatabase({ env: state.env });
    await closeOpenClawStateDatabaseAsync();
    const runtime = createTestRuntime();
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const tty = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
    Object.defineProperty(process.stdout, "isTTY", {
      configurable: true,
      value: options.json === false,
    });
    try {
      const exitCode = await runDoctorLintCli(runtime, {
        json: true,
        severityMin: "error",
        ...options,
      });
      return {
        exitCode,
        runtime,
        lastOutput: String(stdout.mock.calls.at(-1)?.[0]),
        output: stdout.mock.calls.map(([chunk]) => String(chunk)).join(""),
      };
    } finally {
      if (tty) {
        Object.defineProperty(process.stdout, "isTTY", tty);
      } else {
        Reflect.deleteProperty(process.stdout, "isTTY");
      }
    }
  });
}

it.each(["json", "human"] as const)(
  "preserves invalid-config failure and cleanup warnings in %s output",
  async (mode) => {
    const { exitCode, runtime, lastOutput } = await runCleanupLint(
      { json: mode === "json" },
      {
        OPENCLAW_UPDATE_IN_PROGRESS: "1",
        OPENCLAW_UPDATE_POST_CORE_CONVERGENCE: "1",
      },
      { gateway: { mode: "fixture-invalid-mode" } },
    );
    expect(exitCode).toBe(1);
    if (mode === "json") {
      const report = JSON.parse(lastOutput);
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
        expect.stringContaining("Temporary doctor lint state snapshot cleanup did not complete."),
      );
    }
  },
);

it("preserves detector failures when ordinary snapshot cleanup fails in human output", async () => {
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
  const { exitCode, output } = await runCleanupLint(
    { json: false, onlyIds: ["core/doctor/runtime-tool-schemas"] },
    {
      OPENCLAW_UPDATE_IN_PROGRESS: "0",
      OPENCLAW_UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE: "0",
      OPENCLAW_UPDATE_POST_CORE_CONVERGENCE: "0",
    },
  );
  expect(detect).toHaveBeenCalledOnce();
  expect(exitCode).toBe(1);
  expect(output).toContain("[error] core/doctor/runtime-tool-schemas");
  expect(output).toContain("Authoritative detector fixture failure.");
  expect(output).toContain("snapshot cleanup did not complete");
});
