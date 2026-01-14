import { danger, info, logVerboseConsole, success, warn } from "./globals.js";
import { createSubsystemLogger, getLogger } from "./logging.js";
import { defaultRuntime, type RuntimeEnv } from "./runtime.js";

const subsystemPrefixRe = /^([a-z][a-z0-9-]{1,20}):\s+(.*)$/i;

function splitSubsystem(message: string) {
  const match = message.match(subsystemPrefixRe);
  if (!match) return null;
  const [, subsystem, rest] = match;
  return { subsystem, rest };
}

export function logInfo(message: string, runtime: RuntimeEnv = defaultRuntime) {
  const parsed = runtime === defaultRuntime ? splitSubsystem(message) : null;
  if (parsed) {
    createSubsystemLogger(parsed.subsystem).info(parsed.rest);
    return;
  }
  runtime.log(info(message));
  getLogger().info(message);
}

export function logWarn(message: string, runtime: RuntimeEnv = defaultRuntime) {
  const parsed = runtime === defaultRuntime ? splitSubsystem(message) : null;
  if (parsed) {
    createSubsystemLogger(parsed.subsystem).warn(parsed.rest);
    return;
  }
  runtime.log(warn(message));
  getLogger().warn(message);
}

export function logSuccess(message: string, runtime: RuntimeEnv = defaultRuntime) {
  const parsed = runtime === defaultRuntime ? splitSubsystem(message) : null;
  if (parsed) {
    createSubsystemLogger(parsed.subsystem).info(parsed.rest);
    return;
  }
  runtime.log(success(message));
  getLogger().info(message);
}

export function logError(message: string, runtime: RuntimeEnv = defaultRuntime) {
  const parsed = runtime === defaultRuntime ? splitSubsystem(message) : null;
  if (parsed) {
    createSubsystemLogger(parsed.subsystem).error(parsed.rest);
    return;
  }
  runtime.error(danger(message));
  getLogger().error(message);
}

export function logDebug(message: string) {
  // Always emit to file logger (level-filtered); console only when verbose.
  getLogger().debug(message);
  logVerboseConsole(message);
}
