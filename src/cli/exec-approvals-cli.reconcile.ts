import type { Command } from "commander";
import { sanitizeForLog } from "../../packages/terminal-core/src/ansi.js";
import { defaultRuntime } from "../runtime.js";

type ReconcileOptions = { json?: boolean; keepCurrent?: boolean };

export function registerExecApprovalsReconcileCli(
  approvals: Command,
  fail: (error: unknown, opts: ReconcileOptions) => void,
): void {
  approvals
    .command("reconcile")
    .description("Inspect retired local approvals or archive them while keeping current policy")
    .option("--keep-current", "Archive legacy JSON and preserve the current SQLite policy", false)
    .option("--json", "Output JSON", false)
    .action(async (opts: ReconcileOptions) => {
      try {
        const { resolveStateDir } = await import("../config/paths.js");
        const {
          inspectLegacyExecApprovals,
          detectLegacyExecApprovals,
          migrateLegacyExecApprovals,
        } = await import("../infra/state-migrations.exec-approvals.js");
        const stateDir = resolveStateDir();
        if (!opts.keepCurrent) {
          const inspection = await inspectLegacyExecApprovals({ stateDir });
          if (opts.json) {
            defaultRuntime.writeJson(inspection, 0);
          } else {
            defaultRuntime.log(JSON.stringify(inspection, null, 2));
            if (inspection.pending && inspection.current?.valid) {
              defaultRuntime.log(
                "To preserve current SQLite policy, stop the Gateway and node hosts, then run `openclaw approvals reconcile --keep-current` in this same profile. The legacy file will be archived. No policy is changed.",
              );
            } else if (inspection.pending) {
              defaultRuntime.log(
                "No valid current SQLite policy is available to preserve. Keep the legacy file and run `openclaw doctor --fix` in this same profile to diagnose migration before choosing a policy.",
              );
            }
          }
          return;
        }
        const result = await migrateLegacyExecApprovals({
          stateDir,
          detected: detectLegacyExecApprovals({ stateDir, doctorOnlyStateMigrations: true }),
          keepCanonical: true,
        });
        if (opts.json) {
          defaultRuntime.writeJson(result, 0);
        } else {
          for (const message of [
            ...result.changes,
            ...(result.notices ?? []),
            ...result.warnings,
          ]) {
            defaultRuntime.log(sanitizeForLog(message));
          }
        }
        if (result.warnings.length > 0) {
          defaultRuntime.exit(1);
        }
      } catch (err) {
        fail(err, opts);
      }
    });
}
