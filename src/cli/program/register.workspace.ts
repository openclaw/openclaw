import type { Command } from "commander";
import {
  workspaceSyncPullCommand,
  workspaceSyncPushCommand,
} from "../../commands/workspace-sync.js";
import { defaultRuntime } from "../../runtime.js";
import { runCommandWithRuntime } from "../cli-utils.js";

/**
 * Registers the 'workspace' command group for managing local agents' context assets.
 */
export function registerWorkspaceCommands(program: Command) {
  const workspace = program
    .command("workspace")
    .description("Manage local agent bootstrap files (context assets)");

  workspace
    .command("pull")
    .description("Pull fresh context files (SOUL.md, etc.) from the remote sync manifest")
    .option("--workspace <dir>", "Local workspace directory override")
    .option("--json", "Output results as JSON", false)
    .action(async (opts) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        await workspaceSyncPullCommand(opts);
      });
    });

  workspace
    .command("push")
    .description("Push local context files (SOUL.md, etc.) to the remote sync endpoint")
    .option("--workspace <dir>", "Local workspace directory override")
    .option("--json", "Output results as JSON", false)
    .action(async (opts) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        await workspaceSyncPushCommand(opts);
      });
    });

  // Default action: show help.
  workspace.action(() => {
    workspace.help();
  });
}
