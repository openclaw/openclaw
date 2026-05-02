import type { Command } from "commander";
import { runExperimental } from "../../commands/experimental.js";
import { defaultRuntime } from "../../runtime.js";
import { runCommandWithRuntime } from "../cli-utils.js";

export function registerExperimentalCommand(program: Command) {
  program
    .command("experimental")
    .description("Toggle experimental config flags interactively")
    .action(async () => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        await runExperimental(defaultRuntime);
      });
    });
}
