import { theme } from "./terminal/theme.js";

// Logger is lazy-loaded to avoid pulling tslog + config/paths at module init.
// These are only needed when verbose mode is active.
let _logMod: typeof import("./logging/logger.js") | undefined;
function logMod() {
  // Use synchronous cache — the import is pre-warmed before first access
  // because logVerbose/shouldLogVerbose are never called at module init time.
  return _logMod;
}

let globalVerbose = false;
let globalYes = false;

export function setVerbose(v: boolean) {
  globalVerbose = v;
}

export function isVerbose() {
  return globalVerbose;
}

export function shouldLogVerbose() {
  return globalVerbose || Boolean(logMod()?.isFileLogLevelEnabled("debug"));
}

/**
 * Must be called once (asynchronously) before logVerbose can write to file.
 * Typically invoked in CLI preaction or at the start of a command action.
 */
export async function warmLoggerModule() {
  _logMod ??= await import("./logging/logger.js");
}

export function logVerbose(message: string) {
  if (!shouldLogVerbose()) {
    return;
  }
  try {
    logMod()?.getLogger().debug({ message }, "verbose");
  } catch {
    // ignore logger failures to avoid breaking verbose printing
  }
  if (!globalVerbose) {
    return;
  }
  console.log(theme.muted(message));
}

export function logVerboseConsole(message: string) {
  if (!globalVerbose) {
    return;
  }
  console.log(theme.muted(message));
}

export function setYes(v: boolean) {
  globalYes = v;
}

export function isYes() {
  return globalYes;
}

// Defer theme access: arrow functions avoid TDZ issues when the bundler
// reorders globals.ts before theme.ts within the same chunk.
export const success = (s: string) => theme.success(s);
export const warn = (s: string) => theme.warn(s);
export const info = (s: string) => theme.info(s);
export const danger = (s: string) => theme.error(s);
