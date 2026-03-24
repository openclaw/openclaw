import {
  createMigrateArchive,
  formatMigrateExportSummary,
  type MigrateExportOptions,
  type MigrateExportResult,
} from "../infra/migrate-export.js";
import {
  formatMigrateImportSummary,
  importMigrateArchive,
  type MigrateImportOptions,
  type MigrateImportResult,
} from "../infra/migrate-import.js";
import { type RuntimeEnv, writeRuntimeJson } from "../runtime.js";

export type { MigrateExportOptions, MigrateExportResult } from "../infra/migrate-export.js";
export type { MigrateImportOptions, MigrateImportResult } from "../infra/migrate-import.js";

export async function migrateExportCommand(
  runtime: RuntimeEnv,
  opts: MigrateExportOptions = {},
): Promise<MigrateExportResult> {
  const result = await createMigrateArchive(opts);
  if (opts.json) {
    writeRuntimeJson(runtime, result);
  } else {
    runtime.log(formatMigrateExportSummary(result).join("\n"));
  }
  return result;
}

export async function migrateImportCommand(
  runtime: RuntimeEnv,
  opts: MigrateImportOptions,
): Promise<MigrateImportResult> {
  const result = await importMigrateArchive(opts);
  if (opts.json) {
    writeRuntimeJson(runtime, result);
  } else {
    runtime.log(formatMigrateImportSummary(result).join("\n"));
  }
  return result;
}
