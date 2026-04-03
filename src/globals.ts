export { isVerbose, isYes, setVerbose, setYes } from "./global-state.js";
import { isVerbose } from "./global-state.js";
import { getLogger, isFileLogLevelEnabled } from "./logging/logger.js";
import { theme } from "./terminal/theme.js";

export function shouldLogVerbose() {
  return isVerbose() || isFileLogLevelEnabled("debug");
}

export function logVerbose(message: string) {
  if (!shouldLogVerbose()) {
    return;
  }
  try {
    getLogger().debug({ message }, "verbose");
  } catch {
    // ignore logger failures to avoid breaking verbose printing
  }
  if (!isVerbose()) {
    return;
  }
  console.log(theme.muted(message));
}

export function logVerboseConsole(message: string) {
  if (!isVerbose()) {
    return;
  }
  console.log(theme.muted(message));
}

export const success = theme.success;
export const warn = theme.warn;
export const info = theme.info;
export const danger = theme.error;
