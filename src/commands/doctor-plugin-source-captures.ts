import { note } from "../../packages/terminal-core/src/note.js";
import { quoteCliArg } from "../cli/quote-cli-arg.js";
import { resolveStateDir } from "../config/state-dir.js";
import { inspectOtherOpenClawProcesses } from "../infra/openclaw-process-census.js";
import {
  inspectLegacyPluginSourceCaptureRoots,
  pruneLegacyPluginSourceCaptures,
} from "../plugins/plugin-source-capture-report.js";
import { getOpenClawDatabaseMaintenanceScope } from "../state/openclaw-state-db-async-lifecycle.js";
import { formatBytes } from "./doctor-disk-space.js";
import { inspectDoctorTemporaryDirectories } from "./doctor/shared/temporary-directories.js";

export async function noteLegacyPluginSourceCaptures(
  env: NodeJS.ProcessEnv,
  shouldRepair = false,
): Promise<void> {
  const { directories, warnings } = await inspectDoctorTemporaryDirectories(env);
  const report = await inspectLegacyPluginSourceCaptureRoots(resolveStateDir(env), directories);
  warnings.push(...report.warnings);
  const lines: string[] = [];
  if (report.roots.length > 0) {
    lines.push(
      `${report.roots.length} legacy plugin capture root(s), ${formatBytes(report.totalBytes)} in known regular files.`,
      ...report.roots.map((root) => `- ${quoteCliArg(root.path)} (${formatBytes(root.bytes)})`),
      "They will be reclaimed at the next maintenance.",
    );
    if (shouldRepair) {
      const maintenance = getOpenClawDatabaseMaintenanceScope();
      const result = await pruneLegacyPluginSourceCaptures(report, () => {
        if (!maintenance?.ownsSchemaMaintenance) {
          throw new Error(
            "Doctor does not hold Gateway maintenance; legacy captures were preserved.",
          );
        }
        maintenance.assertAdmission();
        const census = inspectOtherOpenClawProcesses();
        if ("error" in census) {
          throw new Error(census.error);
        }
        if (census.pids.length > 0) {
          throw new Error(
            `Other OpenClaw processes are still running (PIDs: ${census.pids.join(", ")}).`,
          );
        }
        maintenance.assertAdmission();
      });
      if (result.removed.length > 0) {
        lines.push(
          `Removed ${result.removed.length} legacy plugin capture root(s), ${formatBytes(result.removed.reduce((bytes, root) => bytes + root.bytes, 0))}.`,
          ...result.removed.map(
            (root) => `Removed ${quoteCliArg(root.path)} (${formatBytes(root.bytes)}).`,
          ),
        );
      }
      if (result.blockedReason) {
        lines.push(`Legacy capture cleanup skipped: ${result.blockedReason}`);
      }
      lines.push(
        ...result.skipped.map((root) => `Kept ${quoteCliArg(root.path)}: ${root.reason}.`),
      );
      warnings.push(...result.warnings);
    }
  }
  if (warnings.length > 0) {
    lines.push(
      "Legacy capture inspection or cleanup was incomplete; sizes may be partial.",
      ...warnings,
    );
  }
  if (lines.length > 0) {
    note(lines.join("\n"), "Legacy plugin captures");
  }
}
