import chalk from "chalk";
import { getLogger, isFileLogLevelEnabled } from "./logging.js";

let globalVerbose = false;
let globalYes = false;

export function setVerbose(v: boolean) {
  globalVerbose = v;
}

export function isVerbose() {
  return globalVerbose;
}

export function shouldLogVerbose() {
  return globalVerbose || isFileLogLevelEnabled("debug");
}

export function logVerbose(message: string) {
  if (!shouldLogVerbose()) return;
  try {
    getLogger().debug({ message }, "verbose");
  } catch {
    // ignore logger failures to avoid breaking verbose printing
  }
  if (!globalVerbose) return;
  console.log(chalk.gray(message));
}

export function logVerboseConsole(message: string) {
  if (!globalVerbose) return;
  console.log(chalk.gray(message));
}

export function setYes(v: boolean) {
  globalYes = v;
}

export function isYes() {
  return globalYes;
}

export const success = chalk.green;
export const warn = chalk.yellow;
export const info = chalk.cyan;
export const danger = chalk.red;
