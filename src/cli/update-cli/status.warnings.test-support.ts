import fs from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import {
  createUpdateRun,
  finishUpdateRun,
  recordUpdateRunStep,
} from "../../infra/update-run-ledger.js";
import { printResult } from "./progress.js";
import { updateStatusCommand } from "./status.js";

export function registerUpdateStatusWarningTests(readConsoleOutput: () => string) {
  it.each(["summary", "report", "status"] as const)(
    "shows every recorded warning and recovery path in the human %s",
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
            "Database changed during capture; its snapshot requires manual recovery: /fixture/agents/analyst/agent/openclaw-agent.sqlite",
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
      finishUpdateRun(run.runId, { status: "succeeded" });
      if (surface === "status") {
        await updateStatusCommand({});
      } else {
        await printResult(
          { runId: run.runId, status: "ok", mode: "npm", steps: [], durationMs: 0 },
          {},
        );
      }
      const output =
        surface === "report"
          ? await fs.readFile(
              path.join(process.env.OPENCLAW_STATE_DIR!, "update-reports", `${run.runId}.md`),
              "utf8",
            )
          : readConsoleOutput();
      for (const { detail } of warnings) {
        expect.soft(output).toContain(`Warning: ${detail}`);
        expect.soft(output.indexOf(`Warning: ${detail}`)).toBeLessThan(output.indexOf(diagnostic));
      }
    },
  );
}
