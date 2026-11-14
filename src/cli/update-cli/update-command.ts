import type { UpdateCommandOptions } from "./shared.js";

/**
 * `openclaw update`: an adopted immutable installation activates its sealed
 * generation; npm and git installs update through runtime slots; package
 * managers, apps and container images get their own update command.
 */
export async function updateCommand(opts: UpdateCommandOptions): Promise<void> {
  const { tryRunImmutableUpdateCommand } = await import("./update-command-immutable.js");
  if (await tryRunImmutableUpdateCommand(opts)) {
    return;
  }
  const { runUpdateCommand } = await import("./update-slots.js");
  await runUpdateCommand(opts);
}
