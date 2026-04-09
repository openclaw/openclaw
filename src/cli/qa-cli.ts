import type { Command } from "commander";
import { registerQaLabCli } from "../plugin-sdk/qa-lab.js";

export function registerQaCli(program: Command) {
  registerQaLabCli(program);
}
