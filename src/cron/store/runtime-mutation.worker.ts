import type { Logger } from "../service/state.js";
import type { CronRunRecoveryOutcome } from "./run-recovery.types.js";

export function createCronMutationLogger(logs: CronRunRecoveryOutcome["logs"]): Logger {
  const record = (level: keyof Logger) => (fields: unknown, message?: string) => {
    logs.push({ level, fields, message });
  };
  return {
    debug: record("debug"),
    info: record("info"),
    warn: record("warn"),
    error: record("error"),
  };
}
