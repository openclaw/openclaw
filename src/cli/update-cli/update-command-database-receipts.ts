import { sha256Hex } from "../../infra/crypto-digest.js";
import type { UpdateDatabaseBackup } from "../../infra/update-database-backup.js";
import type { UpdateDatabaseWriteReceipt } from "../../infra/update-database-generations.js";
import type { UpdateStepResult } from "../../infra/update-step-result.js";

export function recordUpdateDatabaseWrites(
  backup: UpdateDatabaseBackup,
  writes: UpdateDatabaseWriteReceipt | undefined,
  step: UpdateStepResult,
) {
  const paths = Object.keys(backup.sourceGenerations).toSorted();
  let receipt: UpdateStepResult | undefined;
  if (
    !writes ||
    JSON.stringify(Object.keys(writes.generations).toSorted()) !== JSON.stringify(paths)
  ) {
    step.warnings = [
      ...(step.warnings ?? []),
      "Doctor did not provide complete database write-generation evidence; rollback requires the last verified generation to remain unchanged.",
    ];
  } else {
    const fingerprint = sha256Hex(
      JSON.stringify(paths.map((file) => [file, writes.generations[file]])),
    );
    const diagnostics = [
      `Post-migration write inventory: ${paths.length} databases; SHA-256 ${fingerprint}. Snapshots: ${backup.directory}.`,
      ...paths.map(
        (file) => `Database write fingerprint: ${file}; ${writes.generations[file] ?? "absent"}`,
      ),
    ];
    receipt = {
      name: "database migration writes",
      command: "record Doctor database write fingerprints",
      cwd: backup.directory,
      durationMs: 0,
      exitCode: 0,
      diagnostics,
    };
    step.diagnostics = [...(step.diagnostics ?? []), ...diagnostics];
    if (!writes.unchanged) {
      backup.restoreRefusal ??= "databases changed after snapshot capture; the writer is unknown";
    } else if (!backup.restoreRefusal) {
      backup.postMigrationGenerations = writes.generations;
    }
  }
  if (backup.restoreRefusal) {
    step.warnings = [
      ...(step.warnings ?? []),
      `Automatic database restoration unavailable: ${backup.restoreRefusal}. Snapshots retained at ${backup.directory}.`,
    ];
  }
  return receipt;
}
