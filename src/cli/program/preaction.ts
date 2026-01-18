import type { Command } from "commander";
import { emitCliBanner } from "../banner.js";

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
  });
}
