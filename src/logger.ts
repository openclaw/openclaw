import { danger, info, logVerboseConsole, success, warn } from "./globals.js";
import { getLogger } from "./logging/logger.js";
import { createSubsystemLogger } from "./logging/subsystem.js";
import { defaultRuntime, type RuntimeEnv } from "./runtime.js";

const subsystemPrefixRe = /^([a-z][a-z0-9-]{1,20}):\s+(.*)$/i;
const terminalControlSequencePatterns = [
  /\x1B\[[0-9;?]*[ -/]*[@-~]/g,
  /\x1B\][^\x07]*(?:\x07|\x1B\\)/g,
  /\[\?[0-9;]*[hl]/g,
  /\]0;[^\r\n]*/g,
];

function sanitizeTerminalArtifacts(message: string) {
  let text = typeof message === "string" ? message : String(message ?? "");
  for (const pattern of terminalControlSequencePatterns) {
    text = text.replace(pattern, "");
  }
  text = text.replace(/\[(?:\?[\d;]+[hl]|(?:\d{1,3}(?:;\d{1,3})*)?[A-Za-z])/g, "");
  text = text.replace(/\x1B/g, "").replace(/\x07/g, "");
  return text.trim();
}

function splitSubsystem(message: string) {
  const match = message.match(subsystemPrefixRe);
  if (!match) {
    return null;
  }
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
  const cleanMessage = sanitizeTerminalArtifacts(message);
  const parsed = runtime === defaultRuntime ? splitSubsystem(cleanMessage) : null;
  if (parsed) {
    createSubsystemLogger(parsed.subsystem).error(parsed.rest);
    return;
  }
  runtime.error(danger(cleanMessage));
  getLogger().error(cleanMessage);
}

export function logDebug(message: string) {
  // Always emit to file logger (level-filtered); console only when verbose.
  getLogger().debug(message);
  logVerboseConsole(message);
}
