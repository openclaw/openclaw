import { expect, it } from "vitest";
import {
  createUpdateRun,
  finishUpdateRun,
  getUpdateRun,
  recordUpdateRunOwedStep,
  recordUpdateRunStep,
} from "../../infra/update-run-ledger.js";
import { printResult } from "./progress.js";
import { updateStatusCommand } from "./status.js";

export function registerUpdateStatusWarningTests(readConsoleOutput: () => string) {
  for (const surface of ["summary", "status"] as const) {
    it.each(["completed", "failed", "skipped", undefined] as const)(
      `settles historical retirement warnings only with a completed receipt in ${surface} (receipt=%s)`,
      async (status) => {
        const run = createUpdateRun({ trigger: "cli" });
        const retirement = "finalize:doctor:model-retirement";
        const completion = "Deferred model retirement repair completed after plugin convergence.";
        const unrelated = "Other repair still pending.";
        if (status) {
          recordUpdateRunStep(run.runId, { step: retirement, status });
        }
        recordUpdateRunStep(run.runId, {
          step: `warning:${retirement}`,
          status: "completed",
          detail: completion,
        });
        recordUpdateRunStep(run.runId, {
          step: "warning:doctor",
          status: "completed",
          detail: unrelated,
        });
        const saved = finishUpdateRun(run.runId, { status: "succeeded" });
        if (surface === "status") {
          await updateStatusCommand({});
        } else {
          await printResult(
            { runId: run.runId, status: "ok", mode: "npm", steps: [], durationMs: 0 },
            {},
          );
        }
        expect(readConsoleOutput()).toContain(`Warning: ${unrelated}`);
        expect(readConsoleOutput().includes(`Warning: ${completion}`)).toBe(status !== "completed");
        expect(getUpdateRun(run.runId)?.steps).toEqual(saved.steps);
      },
    );
  }

  it.each(["summary", "status"] as const)(
    "retains every recorded warning and recovery path after the human %s",
    async (surface) => {
      const run = createUpdateRun({ trigger: "cli" });
      const snapshotDirectory = `/fixture/${"long-installation-prefix/".repeat(16)}.openclaw.package-backup-test.databases`;
      const diagnostic = "Databases snapshotted; retain recovery artifacts.";
      recordUpdateRunStep(run.runId, {
        step: "diagnostic:database snapshot",
        status: "completed",
        detail: diagnostic,
      });
      const warnings = [
        {
          step: "warning:database snapshot",
          detail:
            "Database write generation changed or could not be confirmed during capture (the running Gateway may have written to it); automatic rollback keeps the live database instead of this snapshot: /fixture/agents/analyst/agent/openclaw-agent.sqlite",
        },
        {
          step: "warning:database snapshot:3",
          detail: `Automatic database restoration is disabled because a source database changed or its write generation could not be captured. Snapshots remain available at ${snapshotDirectory}; later writes must be preserved.`,
        },
        {
          step: "warning:local-package-overrides",
          detail:
            "Local package overrides: preserved; 0 replayed. Recovery bundle: /fixture/update-recovery/openclaw-local-overrides-test. Local OpenClaw changes were preserved in the recovery bundle and were not reapplied.",
        },
        ...[1, 2, 3].map((index) => ({
          step: `warning:doctor:${index}`,
          detail: `Optional Doctor repair ${index} was deferred. Existing settings were preserved because this optional inspection could not complete. Review the retained diagnostics and run openclaw doctor to inspect the current state before retrying the repair.`,
        })),
      ];
      for (const warning of warnings) {
        recordUpdateRunStep(run.runId, { ...warning, status: "completed" });
      }
      recordUpdateRunOwedStep(run.runId, "shell-completion", "Completion directory is read-only.");
      finishUpdateRun(run.runId, { status: "succeeded" });
      if (surface === "status") {
        await updateStatusCommand({});
      } else {
        await printResult(
          { runId: run.runId, status: "ok", mode: "npm", steps: [], durationMs: 0 },
          {},
        );
      }
      expect(readConsoleOutput()).toContain("OpenClaw updated");
      expect(readConsoleOutput()).toContain("Shell completion refresh is owed");
      expect(readConsoleOutput()).toContain("openclaw update repair");
      const recorded = getUpdateRun(run.runId);
      for (const warning of warnings) {
        expect(readConsoleOutput()).toContain(warning.detail);
        expect(recorded?.steps).toContainEqual(
          expect.objectContaining({ ...warning, status: "completed" }),
        );
      }
      expect(recorded?.steps).toContainEqual(
        expect.objectContaining({ step: "diagnostic:database snapshot", detail: diagnostic }),
      );
    },
  );
}
