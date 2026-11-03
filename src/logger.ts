import { theme } from "../packages/terminal-core/src/theme.js";
import { isVerbose } from "./global-state.js";
import { writeRootConsoleLine } from "./logging/console.js";
import { getLogger } from "./logging/logger.js";
import { createSubsystemLogger } from "./logging/subsystem.js";
import { defaultRuntime, type RuntimeEnv } from "./runtime.js";

const subsystemPrefixRe = /^([a-z][a-z0-9-]{1,20}):\s+(.*)$/i;

function splitSubsystem(message: string) {
  const match = message.match(subsystemPrefixRe);
  if (!match) {
    return null;
  }
  const subsystem = match.at(1);
  const rest = match.at(2);
  if (subsystem === undefined || rest === undefined) {
    return null;
  }
  return { subsystem, rest };
}

type LogMethod = "info" | "warn" | "error";
function logWithSubsystem(level: LogMethod, message: string, runtime: RuntimeEnv) {
  const parsed = runtime === defaultRuntime ? splitSubsystem(message) : null;
  if (parsed) {
    createSubsystemLogger(parsed.subsystem)[level](parsed.rest);
    return;
  }
  const runtimeMethod = level === "error" ? "error" : "log";
  const formatted = theme[level](message);
  if (runtime !== defaultRuntime || !writeRootConsoleLine(runtimeMethod, formatted)) {
    runtime[runtimeMethod](formatted);
  }
  getLogger()[level](message);
}

export function logInfo(message: string, runtime: RuntimeEnv = defaultRuntime) {
  logWithSubsystem("info", message, runtime);
}

export function logWarn(message: string, runtime: RuntimeEnv = defaultRuntime) {
  logWithSubsystem("warn", message, runtime);
}

export function logError(message: string, runtime: RuntimeEnv = defaultRuntime) {
  logWithSubsystem("error", message, runtime);
}

export function logDebug(message: string) {
  // Always emit to file logger (level-filtered); console only when verbose.
  getLogger().debug(message);
  if (isVerbose()) {
    console.log(theme.muted(message));
  }
}
