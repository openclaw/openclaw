import { type RuntimeEnv, writeRuntimeJson } from "../runtime.js";
import { recordBackupOutcomeBestEffort } from "./backup-shared.js";

export type BackupRecordOptions = {
  status?: string;
  target?: string;
  bytes?: string | number;
  error?: string;
  json?: boolean;
};

/** Host-owned jobs can contribute outcomes without changing their execution owner. */
export async function backupRecordCommand(
  runtime: RuntimeEnv,
  opts: BackupRecordOptions,
): Promise<void> {
  if (opts.status !== "ok" && opts.status !== "failed") {
    throw new Error("--status must be ok or failed.");
  }
  const target = opts.target?.trim();
  if (!target) {
    throw new Error("Missing required --target label.");
  }
  const bytes = opts.bytes === undefined ? undefined : Number(opts.bytes);
  if (
    bytes !== undefined &&
    (!Number.isSafeInteger(bytes) || bytes < 0 || String(opts.bytes).trim() === "")
  ) {
    throw new Error("--bytes must be a nonnegative integer.");
  }
  const outcome = {
    kind: "external" as const,
    archivePath: target,
    target,
    status: opts.status,
    ...(bytes !== undefined ? { bytes } : {}),
    ...(opts.error ? { error: opts.error } : {}),
  };
  await recordBackupOutcomeBestEffort(runtime, outcome);
  if (opts.json) {
    writeRuntimeJson(runtime, outcome);
  } else {
    runtime.log(`External backup: ${target} (${opts.status})`);
  }
}
