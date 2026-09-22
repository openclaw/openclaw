import os from "node:os";
import { note } from "../../packages/terminal-core/src/note.js";
import { maintainBackupScratch } from "../infra/backup-scratch.js";
import { formatErrorMessage } from "../infra/errors.js";
import { readBackupArchiveDirectories } from "../state/backup-run-records.js";

export async function noteBackupScratchHealth(
  env: NodeJS.ProcessEnv,
  shouldRepair: boolean,
): Promise<void> {
  const roots = [os.tmpdir()];
  try {
    roots.push(...readBackupArchiveDirectories(env));
  } catch (error) {
    note(
      `Cannot discover recorded backup scratch locations: ${formatErrorMessage(error)}`,
      "Backups",
    );
  }
  const report = await maintainBackupScratch({ roots, repair: shouldRepair });
  const lines = [
    ...report.unchecked.map(
      (directory) =>
        `Backup scratch awaiting lifecycle check: ${directory}. Run \`openclaw doctor --fix\` to remove it if abandoned.`,
    ),
    ...report.reclaimed.map((directory) => `Removed abandoned backup scratch: ${directory}`),
    ...report.alreadyReclaimed.map((directory) => `Backup scratch already reclaimed: ${directory}`),
    ...report.active.map((directory) => `Kept active backup scratch: ${directory}`),
    ...report.warnings,
  ];
  if (lines.length) {
    note(lines.join("\n"), "Backup scratch");
  }
}
