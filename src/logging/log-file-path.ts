// Log file path helpers resolve log output paths for local runtime logs.
import path from "node:path";
import type { OpenClawConfig } from "../config/types.js";
import {
  POSIX_OPENCLAW_TMP_DIR,
  resolvePreferredOpenClawTmpDir,
} from "../infra/tmp-openclaw-dir.js";
import { canUseNodeFs, formatLocalDate, LOG_PREFIX, LOG_SUFFIX } from "./log-file-shared.js";

function resolveDefaultRollingLogFile(date = new Date()): string {
  const logDir = canUseNodeFs() ? resolvePreferredOpenClawTmpDir() : POSIX_OPENCLAW_TMP_DIR;
  return path.join(logDir, `${LOG_PREFIX}-${formatLocalDate(date)}${LOG_SUFFIX}`);
}

/** Resolves the configured log file or today's rolling default log path. */
export function resolveConfiguredLogFilePath(config?: OpenClawConfig | null): string {
  return config?.logging?.file ?? resolveDefaultRollingLogFile();
}
