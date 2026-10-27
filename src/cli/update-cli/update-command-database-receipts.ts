import { sha256Hex } from "../../infra/crypto-digest.js";
import type { UpdateDatabaseBackup } from "../../infra/update-database-backup.js";
import type { UpdateDatabaseWriteReceipt } from "../../infra/update-database-generations.js";
import {
  UPDATE_DOCTOR_HISTORICAL_SCANS_ENV,
  type UpdateDoctorHistoricalScans,
} from "../../infra/update-doctor-scan-receipts.js";
import type { UpdateStepResult } from "../../infra/update-step-result.js";
import { isStatePostgres } from "../../state/openclaw-state-db-engine.js";
import { closeOpenClawStateDatabaseByPathAsync } from "../../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";

// The installed driver records the first Doctor receipt here. Its existing backup
// object is the operation identity shared with post-plugin convergence. No durable cache.
const historicalScans = new WeakMap<UpdateDatabaseBackup, UpdateDoctorHistoricalScans>();

export async function observeUpdateParentDatabaseWrites(
  backup: UpdateDatabaseBackup,
  options: {
    env: NodeJS.ProcessEnv;
    root?: string;
    signal?: AbortSignal;
    assertCurrent?: () => void;
  },
): Promise<void> {
  const pathname = resolveOpenClawStateSqlitePath(options.env);
  if (isStatePostgres() || !Object.hasOwn(backup.sourceGenerations, pathname)) {
    return;
  }
  options.assertCurrent?.();
  try {
    // Close first so Doctor receives the post-close fingerprint and can take native exclusion.
    await closeOpenClawStateDatabaseByPathAsync(pathname);
    const { readUpdateDatabaseGenerationsIsolated } =
      await import("../../infra/update-candidate-state.js");
    const generations = await readUpdateDatabaseGenerationsIsolated([pathname], options);
    options.assertCurrent?.();
    if (typeof generations[pathname] !== "string") {
      throw new Error("Update ledger database is unavailable before Doctor admission.");
    }
    // Like native Doctor close (#177831), this can absorb raw outside writes during
    // the update window to the state database the parent itself writes.
    if (!backup.restoreRefusal) {
      backup.migration = {
        name: backup.migration?.name ?? "update ledger writes",
        backup: backup.directory,
        from: backup.migration?.from ?? backup.sourceGenerations,
        to: { ...(backup.migration?.to ?? backup.sourceGenerations), ...generations },
      };
    }
  } catch (error) {
    backup.restoreRefusal ??= "update ledger database generation could not be observed";
    throw error;
  }
}

export function consumeUpdateDoctorHistoricalScans(
  backup: UpdateDatabaseBackup,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const scans = historicalScans.get(backup);
  historicalScans.delete(backup);
  const encoded = scans?.length ? JSON.stringify(scans) : undefined;
  if (!encoded) {
    return undefined;
  }
  // Windows bounds the entire UTF-16 environment block, not each variable.
  // Optional reuse must never turn an otherwise valid Doctor spawn into failure.
  const environmentLength = Object.entries(env).reduce(
    (length, [key, value]) => length + (value === undefined ? 0 : key.length + value.length + 2),
    1,
  );
  return environmentLength + UPDATE_DOCTOR_HISTORICAL_SCANS_ENV.length + encoded.length + 2 <=
    30 * 1024
    ? encoded
    : undefined;
}

export function recordUpdateDatabaseWrites(
  backup: UpdateDatabaseBackup,
  writes: UpdateDatabaseWriteReceipt | undefined,
  step: Pick<UpdateStepResult, "name">,
): UpdateStepResult {
  historicalScans.delete(backup);
  if (writes?.historicalScans?.length) {
    historicalScans.set(backup, writes.historicalScans);
  }
  const paths = Object.keys(backup.sourceGenerations).toSorted();
  const receipt: UpdateStepResult = {
    name: "database migration writes",
    command: "record Doctor database write fingerprints",
    cwd: backup.directory,
    durationMs: 0,
    exitCode: 0,
  };
  if (
    !writes ||
    JSON.stringify(Object.keys(writes.generations).toSorted()) !== JSON.stringify(paths)
  ) {
    receipt.warnings = [
      "Doctor did not provide complete database write-generation evidence; rollback requires the last verified generation to remain unchanged.",
    ];
  } else {
    const expected = backup.migration?.to ?? backup.sourceGenerations;
    // Released Doctor receipts bind their input through unchanged; new ones also report that input.
    const from = writes.fromGenerations ?? expected;
    const fingerprint = sha256Hex(
      JSON.stringify(paths.map((file) => [file, writes.generations[file]])),
    );
    receipt.diagnostics = [
      `Doctor interval ${step.name}; backup ${backup.directory}; from SHA-256 ${sha256Hex(JSON.stringify(paths.map((file) => [file, from[file]])))} to SHA-256 ${fingerprint}.`,
      `Post-migration write inventory: ${paths.length} databases; SHA-256 ${fingerprint}. Snapshots: ${backup.directory}.`,
      ...paths.map(
        (file) => `Database write fingerprint: ${file}; ${writes.generations[file] ?? "absent"}`,
      ),
    ];
    if (!writes.unchanged || paths.some((file) => from[file] !== expected[file])) {
      backup.restoreRefusal ??= "databases changed after snapshot capture; the writer is unknown";
    } else if (!backup.restoreRefusal) {
      backup.migration = {
        name: step.name,
        backup: backup.directory,
        from,
        to: writes.generations,
      };
    }
  }
  if (backup.restoreRefusal) {
    // The first warning owns the retained ledger key, regardless of Doctor's other warnings.
    receipt.warnings = [
      `Automatic database restoration unavailable: ${backup.restoreRefusal}. Snapshots retained at ${backup.directory}.`,
      ...(receipt.warnings ?? []),
    ];
  }
  return receipt;
}
