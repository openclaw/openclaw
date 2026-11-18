import { afterEach, expect, it, vi } from "vitest";
import { createCliTtyMock } from "../cli/test-runtime-capture.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { runDoctorLintCli } from "./doctor-lint.js";
import { createTestRuntime } from "./test-runtime-config-helpers.js";

vi.mock("../infra/sqlite-snapshot-source.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../infra/sqlite-snapshot-source.js")>();
  return {
    ...actual,
    async forkSqlitePrivateSnapshot(...args: Parameters<typeof actual.forkSqlitePrivateSnapshot>) {
      const prepared = await actual.forkSqlitePrivateSnapshot(...args);
      return { ...prepared, cleanupAsync: () => prepared.cleanupAsync().then(() => false) };
    },
  };
});

afterEach(async () => {
  vi.restoreAllMocks();
  await closeOpenClawStateDatabaseAsync();
});

// Detector failures plus cleanup are covered by state-isolation's cleanup-detector case.
it.each([true, false])(
  "keeps invalid-config errors and cleanup warnings (json=%s)",
  async (json) => {
    await withOpenClawTestState(
      {
        prefix: "doctor-lint-cleanup-",
        env: { OPENCLAW_UPDATE_IN_PROGRESS: "1", OPENCLAW_UPDATE_POST_CORE_CONVERGENCE: "1" },
      },
      async (state) => {
        await state.writeConfig({ gateway: { mode: "fixture-invalid-mode" } });
        openOpenClawStateDatabase({ env: state.env });
        await closeOpenClawStateDatabaseAsync();
        const runtime = createTestRuntime();
        const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
        const tty = createCliTtyMock([process.stdout]);
        tty.set(!json);
        try {
          expect(await runDoctorLintCli(runtime, { json, severityMin: "error" })).toBe(1);
          if (json) {
            const report = JSON.parse(String(stdout.mock.calls.at(-1)?.[0]));
            expect(report.ok).toBe(false);
            expect(report.findings).toContainEqual(
              expect.objectContaining({
                severity: "error",
                path: "gateway.mode",
              }),
            );
            expect(report.warnings).toContainEqual(
              expect.objectContaining({
                severity: "warning",
                requirement: "temporary-snapshot-cleanup",
              }),
            );
          } else {
            expect(runtime.error).toHaveBeenCalledWith(expect.stringContaining("gateway.mode"));
            expect(runtime.error).toHaveBeenCalledWith(
              expect.stringContaining(
                "Temporary doctor lint state snapshot cleanup did not complete.",
              ),
            );
          }
        } finally {
          tty.restore();
        }
      },
    );
  },
);
