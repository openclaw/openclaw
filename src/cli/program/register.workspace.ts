import type { Command } from "commander";
import { workspaceResetCommand } from "../../commands/workspace.js";
import { defaultRuntime } from "../../runtime.js";
import { formatDocsLink } from "../../terminal/links.js";
import { theme } from "../../terminal/theme.js";
import { runCommandWithRuntime } from "../cli-utils.js";
import { formatHelpExamples } from "../help-format.js";

export function registerWorkspaceCommand(program: Command) {
  const workspace = program
    .command("workspace")
    .description("Manage agent workspaces")
    .addHelpText(
      "after",
      () =>
        `\n${theme.muted("Docs:")} ${formatDocsLink("/cli/workspace", "docs.openclaw.ai/cli/workspace")}\n`,
    );

  workspace
    .command("reset")
    .description("Reset only the active agent workspace and reseed it as a fresh agent")
    .option("--workspace <dir>", "Explicit workspace directory to reset")
    .option("--agent <id>", "Agent id to resolve workspace/sessions from the active config")
    .option("--include-sessions", "Also clear this agent's session transcripts", false)
    .option("--yes", "Skip the confirmation prompt", false)
    .option("--dry-run", "Print the reset plan without moving anything", false)
    .addHelpText(
      "after",
      () =>
        `\n${theme.heading("Examples:")}\n${formatHelpExamples([
          ["openclaw workspace reset", "Trash and reseed only the active workspace."],
          [
            "openclaw workspace reset --include-sessions",
            "Also clear the active agent's session transcripts.",
          ],
          [
            "openclaw workspace reset --agent ops",
            "Reset the workspace resolved for a specific agent id.",
          ],
          [
            "openclaw workspace reset --workspace ~/tmp/test-workspace --dry-run",
            "Preview a custom workspace-only reset.",
          ],
        ])}`,
    )
    .action(async (opts) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        await workspaceResetCommand(defaultRuntime, {
          workspace: opts.workspace as string | undefined,
          agent: opts.agent as string | undefined,
          includeSessions: Boolean(opts.includeSessions),
          yes: Boolean(opts.yes),
          dryRun: Boolean(opts.dryRun),
        });
      });
    });
}
