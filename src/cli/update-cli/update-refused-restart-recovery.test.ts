import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import * as ledger from "../../infra/update-run-ledger.js";
import type { UpdateRunRecord } from "../../infra/update-run-record.js";
import { renderUpdateRunReport } from "../../infra/update-run-report.js";
import * as state from "../../state/openclaw-state-db.js";
import {
  REFUSED_RESTART_RECOVERY,
  resolveRefusedRestartRecovery,
} from "./update-refused-restart-recovery.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(async () => {
  await state.closeOpenClawStateDatabaseAsync();
  state.closeOpenClawStateDatabaseForTest();
});

function writePackage(root: string, version: string) {
  fs.mkdirSync(path.join(root, "dist"), { recursive: true });
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "openclaw", version }));
  fs.writeFileSync(path.join(root, "dist", "index.js"), "export {};\n");
  return fs.realpathSync(root);
}

/** A real ledger row shaped like the shipped 2026.11.5 run after its refused restart. */
function refusedRun(base: string, reason = "service-revalidation-failed"): UpdateRunRecord {
  const options = { env: { OPENCLAW_STATE_DIR: path.join(base, "state") } };
  const { runId } = ledger.createUpdateRun(
    {
      trigger: "cli",
      before: { version: "2026.11.5" },
      target: { kind: "package", version: "2026.11.6" },
    },
    options,
  );
  ledger.finishUpdateRun(
    runId,
    {
      status: "failed",
      reason,
      after: { version: "2026.11.6" },
      nextAction:
        "Run `openclaw triage` on this machine to open a coding agent that can diagnose and repair the installation.",
    },
    options,
  );
  return ledger.getUpdateRun(runId, options)!;
}

it.each([
  { name: "a service still on the previous package", service: "previous", recovery: true },
  { name: "a service already on this package", service: "current", recovery: false },
  { name: "another failure", service: "previous", reason: "doctor-failed", recovery: false },
])("names the verified service recovery only for $name", async (variant) => {
  const base = tempDirs.make("openclaw-refused-restart-");
  const previous = writePackage(path.join(base, "2026.11.5", "openclaw"), "2026.11.5");
  const current = writePackage(path.join(base, "2026.11.6", "openclaw"), "2026.11.6");
  const run = refusedRun(base, variant.reason);
  const command = {
    programArguments: [
      process.execPath,
      path.join(variant.service === "previous" ? previous : current, "dist", "index.js"),
      "gateway",
      "--port",
      "18789",
    ],
  };

  const recovery = await resolveRefusedRestartRecovery({ run, command, activeRoot: current });

  expect(recovery).toBe(variant.recovery ? REFUSED_RESTART_RECOVERY : undefined);
  const report = renderUpdateRunReport(run, recovery ? { nextAction: recovery } : {});
  if (variant.recovery) {
    // The stopped Gateway's next step is the service reinstall, not the generic triage advice.
    expect(report.lines.at(-1)).toBe(REFUSED_RESTART_RECOVERY);
    expect(report.markdown).not.toContain("openclaw triage");
  } else {
    expect(report.markdown).not.toContain("openclaw gateway install --force");
  }
});
