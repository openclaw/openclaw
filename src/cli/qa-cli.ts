import type { Command } from "commander";
import { registerQaLabCli } from "../../extensions/qa-lab/api.js";

export function registerQaCli(program: Command) {
  registerQaLabCli(program);
}
