import chalk from "chalk";

let globalVerbose = false;
let globalYes = false;

export function setVerbose(v: boolean) {
  globalVerbose = v;
}

export function isVerbose() {
  return globalVerbose;
}

export function logVerbose(message: string) {
  if (globalVerbose) console.log(chalk.gray(message));
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
