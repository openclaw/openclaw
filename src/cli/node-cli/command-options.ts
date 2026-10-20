import { Command, InvalidArgumentError } from "commander";

export function createNodeWorkerCommand(): Command {
  return new Command("worker")
    .description("Run the private macOS app node-host worker")
    .option("--desktop-sharing", "Enable the app's desktop viewer capability")
    .option("--no-desktop-sharing", "Disable the app's desktop viewer capability");
}

/** Collect repeatable, comma-separated exact node command ids without treating patterns as globs. */
function collectNodeCommandIds(value: string, previous: string[] = []): string[] {
  const ids = value.split(",").map((id) => id.trim());
  if (ids.some((id) => !id)) {
    throw new InvalidArgumentError("--commands requires comma-separated non-empty command ids");
  }
  return [...new Set([...previous, ...ids])].toSorted();
}

export function addNodeCommandOptions(command: Command): Command {
  return command
    .option(
      "--commands <ids>",
      "Advertise only these exact command ids (comma-separated; repeatable)",
      collectNodeCommandIds,
    )
    .option(
      "--all-commands",
      "Advertise the full default command surface and forget any saved --commands allowlist",
    )
    .hook("preAction", (_command, actionCommand) => {
      // Commander conflicts are local-only; include flags split across node and its leaf.
      const opts = actionCommand.optsWithGlobals();
      if (opts.allCommands && opts.commands !== undefined) {
        actionCommand.error("--all-commands cannot be combined with --commands", {
          code: "commander.conflictingOption",
        });
      }
    });
}
