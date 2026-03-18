import type { RuntimeEnv } from "../runtime.js";
import {
  formatLocalTruthSyncSummary,
  runLocalTruthSync,
  type LocalTruthSyncOptions,
  type LocalTruthSyncResult,
} from "./sync-shared.js";

export type SyncCommandOptions = LocalTruthSyncOptions & {
  json?: boolean;
};

export async function syncCommand(
  runtime: RuntimeEnv,
  options: SyncCommandOptions,
): Promise<LocalTruthSyncResult> {
  const result = await runLocalTruthSync(options);
  runtime.log(
    options.json ? JSON.stringify(result, null, 2) : formatLocalTruthSyncSummary(result).join("\n"),
  );
  return result;
}
