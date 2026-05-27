import { ALLOWED_LOG_LEVELS, type LogLevel, tryParseLogLevel } from "./levels.js";
import { loggingState } from "./state.js";

export function resolveEnvLogLevelOverride(): LogLevel | undefined {
  const raw = process.env.OPENCLAW_LOG_LEVEL;
  const trimmed = typeof raw === "string" ? raw.trim() : "";
  if (!trimmed) {
    loggingState.invalidEnvLogLevelValue = null;
    return undefined;
  }
  const parsed = tryParseLogLevel(trimmed);
  if (parsed) {
    loggingState.invalidEnvLogLevelValue = null;
    return parsed;
  }
  if (loggingState.invalidEnvLogLevelValue !== trimmed) {
    loggingState.invalidEnvLogLevelValue = trimmed;
    process.stderr.write(
      `[openclaw] Ignoring invalid OPENCLAW_LOG_LEVEL="${trimmed}" (allowed: ${ALLOWED_LOG_LEVELS.join("|")}).\n`,
    );
  }
  return undefined;
}
