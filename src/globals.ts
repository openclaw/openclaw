import chalk from "chalk";
import { getLogger } from "./logging.js";

let globalVerbose = false;
let globalYes = false;

export function setVerbose(v: boolean) {
  globalVerbose = v;
}

export function isVerbose() {
  return globalVerbose;
}

export function logVerbose(message: string) {
  // if (globalVerbose) {
  console.log(chalk.gray(message));
  try {
    getLogger().debug({ message }, "verbose");
  } catch {
    // ignore logger failures to avoid breaking verbose printing
  }
  // }
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
