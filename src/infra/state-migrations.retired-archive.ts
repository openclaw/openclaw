import { formatErrorMessage } from "./errors.js";
import { listExistingRetiredStateFiles } from "./state-migrations.retired-files.js";
import { backupLegacyStateSource } from "./state-migrations.source-backup.js";
import type { MigrationMessages } from "./state-migrations.types.js";

/** Doctor preserves retired bytes through the same backup owner as supported imports. */
export async function archiveRetiredStateFiles(params: {
  label: string;
  paths: readonly string[];
  assertCurrent: () => void;
  recoveryInstructions?: string;
}): Promise<MigrationMessages> {
  const result: MigrationMessages = { changes: [], warnings: [] };
  for (const filePath of listExistingRetiredStateFiles([...new Set(params.paths)])) {
    const backup = await backupLegacyStateSource({
      filePath,
      assertCurrent: params.assertCurrent,
    });
    backup.removeSource(() => undefined);
    result.changes.push(`Archived retired ${params.label}: ${filePath} → ${backup.backupPath}`);
    result.warnings.push(
      `${params.label}: original bytes are preserved at ${backup.backupPath}. ${params.recoveryInstructions ?? "This transient state is no longer used and will be rebuilt when needed."}`,
    );
  }
  return result;
}

/** Parsing may reject input; persistence failures must leave the live source retryable. */
export async function importRetiredStateSource<T>(params: {
  source: Awaited<ReturnType<typeof backupLegacyStateSource>>;
  label: string;
  parse: (bytes: Buffer) => T;
  commit: (value: T) => void | Promise<void>;
  recoveryInstructions: string;
  result: MigrationMessages;
}): Promise<void> {
  const { source, label, result, recoveryInstructions } = params;
  let parsed: { value: T } | undefined;
  try {
    parsed = { value: params.parse(source.bytes) };
  } catch (error) {
    result.warnings.push(
      `Could not import ${label}: ${formatErrorMessage(error)}. ${recoveryInstructions}`,
    );
  }
  if (parsed) {
    try {
      source.assertUnchanged();
      await params.commit(parsed.value);
    } catch (error) {
      throw new Error(
        `Could not persist ${label}: ${formatErrorMessage(error)}. The legacy source files remain unchanged. Resolve the database error, then rerun openclaw doctor --fix before updating. Backup: ${source.backupPath}`,
        { cause: error },
      );
    }
    result.changes.push(`Migrated ${label} → shared SQLite state (existing values retained)`);
  }
  source.removeSource(() => undefined);
  result.warnings.push(
    `${label}: original bytes are preserved at ${source.backupPath}. ${recoveryInstructions}`,
  );
}
