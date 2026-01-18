import type { Command } from "commander";
import { defaultRuntime } from "../../runtime.js";
import { emitCliBanner } from "../banner.js";
import { getCommandPath, hasHelpOrVersion, isReadOnlyCommand } from "../argv.js";
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
    const [primary] = getCommandPath(argv, 1);
    if (primary === "doctor") return;
    const migrateState = !isReadOnlyCommand(argv);
    await ensureConfigReady({ runtime: defaultRuntime, migrateState });
  });
}
