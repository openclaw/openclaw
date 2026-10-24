import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { clearHealthChecksForTest } from "../flows/health-check-registry.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { runDoctorLintCli } from "./doctor-lint.js";
import { createTestRuntime } from "./test-runtime-config-helpers.js";

const mocks = vi.hoisted(() => ({ checks: vi.fn(), forked: vi.fn() }));
vi.mock("../flows/doctor-health-contributions.js", () => ({
  resolveDoctorContributionHealthChecks: mocks.checks,
}));
vi.mock("../infra/sqlite-snapshot-source.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../infra/sqlite-snapshot-source.js")>();
  return {
    ...actual,
    async forkSqlitePrivateSnapshot(...args: Parameters<typeof actual.forkSqlitePrivateSnapshot>) {
      const prepared = await actual.forkSqlitePrivateSnapshot(...args);
      mocks.forked(prepared.location);
      return {
        ...prepared,
        cleanupAsync: () => prepared.cleanupAsync().then(() => false),
      };
    },
  };
});

beforeEach(() => {
  clearHealthChecksForTest();
  mocks.forked.mockClear();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await closeOpenClawStateDatabaseAsync();
});

const CHECK_ID = "core/doctor/runtime-tool-schemas";
const DETECTOR_ERROR = "Authoritative detector fixture failure.";

async function runCleanupLint(json: boolean, invalid: boolean) {
  const env = {
    OPENCLAW_UPDATE_IN_PROGRESS: invalid ? "1" : "0",
    OPENCLAW_UPDATE_POST_CORE_CONVERGENCE: invalid ? "1" : "0",
    ...(!invalid && { OPENCLAW_UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE: "0" }),
  };
  const gateway = { mode: invalid ? "fixture-invalid-mode" : "local" };
  const config = invalid ? { gateway } : { gateway, memory: { search: { enabled: false } } };
  return withOpenClawTestState({ prefix: "doctor-lint-cleanup-", env }, async (state) => {
    await state.writeConfig(config);
    openOpenClawStateDatabase({ env: state.env });
    await closeOpenClawStateDatabaseAsync();
    const runtime = createTestRuntime();
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const tty = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
    Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: !json });
    try {
      const exitCode = await runDoctorLintCli(runtime, {
        json,
        severityMin: "error",
        ...(!invalid && { onlyIds: [CHECK_ID] }),
      });
      expect(exitCode).toBe(1);
      expect(mocks.forked).toHaveBeenCalledOnce();
      return {
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

it.each([
  { mode: "json", invalid: true },
  { mode: "human", invalid: true },
  { mode: "human", invalid: false },
])("keeps failure and cleanup warning ($mode/$invalid)", async ({ mode, invalid }) => {
  const detect = vi.fn(async () => {
    throw new Error(DETECTOR_ERROR);
  });
  if (!invalid) {
    mocks.checks.mockResolvedValue([
      { id: CHECK_ID, kind: "core", description: "detector failure", detect },
    ]);
  }
  const { runtime, lastOutput, output } = await runCleanupLint(mode === "json", invalid);
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
  } else if (invalid) {
    for (const message of [
      "doctor --lint: config file exists but does not parse cleanly.",
      expect.stringContaining("gateway.mode"),
      expect.stringContaining("Temporary doctor lint state snapshot cleanup did not complete."),
    ]) {
      expect(runtime.error).toHaveBeenCalledWith(message);
    }
  } else {
    expect(detect).toHaveBeenCalledOnce();
    expect(output).toContain(`[error] ${CHECK_ID}`);
    expect(output).toContain(DETECTOR_ERROR);
    expect(runtime.error).toHaveBeenCalledWith(
      expect.stringContaining("snapshot cleanup did not complete"),
    );
  }
});
