import type { Command } from "commander";
import { registerQaLabCli } from "../qa-e2e/cli.js";

export function registerQaCli(program: Command) {
  registerQaLabCli(program);
}
