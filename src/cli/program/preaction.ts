import type { Command } from "commander";
import { defaultRuntime } from "../../runtime.js";
import { emitCliBanner } from "../banner.js";
import { getCommandPath, hasHelpOrVersion } from "../argv.js";
import { ensureConfigReady } from "./config-guard.js";

function setProcessTitleForCommand(actionCommand: Command) {
  let current: Command = actionCommand;
  while (current.parent && current.parent.parent) {
    current = current.parent;
  }
  const name = current.name();
  if (!name || name === "clawdbot") return;
  process.title = `clawdbot-${name}`;
}

export function registerPreActionHooks(program: Command, programVersion: string) {
  program.hook("preAction", async (_thisCommand, actionCommand) => {
    setProcessTitleForCommand(actionCommand);
    emitCliBanner(programVersion);
    const argv = process.argv;
    if (hasHelpOrVersion(argv)) return;
    const commandPath = getCommandPath(argv, 2);
    if (commandPath[0] === "doctor") return;
    await ensureConfigReady({ runtime: defaultRuntime, commandPath });
  });
}
