import type { Command } from "commander";
import { backupCreateCommand } from "../../commands/backup.js";
import { defaultRuntime } from "../../runtime.js";
import { formatDocsLink } from "../../terminal/links.js";
import { theme } from "../../terminal/theme.js";
import { runCommandWithRuntime } from "../cli-utils.js";
import { formatHelpExamples } from "../help-format.js";

export function registerBackupCommand(program: Command) {
  const backup = program
    .command("backup")
    .description("Create local backup archives for OpenClaw state")
    .addHelpText(
      "after",
      () =>
        `\n${theme.muted("Docs:")} ${formatDocsLink("/cli/backup", "docs.openclaw.ai/cli/backup")}\n`,
    );

  backup
    .command("create")
    .description("Write a backup archive for config, credentials, sessions, and workspaces")
    .option("--output <path>", "Archive path or destination directory")
    .option("--json", "Output JSON", false)
    .option("--dry-run", "Print the backup plan without writing the archive", false)
    .option("--no-include-workspace", "Exclude workspace directories from the backup")
    .addHelpText(
      "after",
      () =>
        `\n${theme.heading("Examples:")}\n${formatHelpExamples([
          ["openclaw backup create", "Create a timestamped backup in the current directory."],
          [
            "openclaw backup create --output ~/Backups",
            "Write the archive into an existing backup directory.",
          ],
          [
            "openclaw backup create --dry-run --json",
            "Preview the archive plan without writing any files.",
          ],
          [
            "openclaw backup create --no-include-workspace",
            "Back up state/config without agent workspace files.",
          ],
        ])}`,
    )
    .action(async (opts) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        await backupCreateCommand(defaultRuntime, {
          output: opts.output as string | undefined,
          json: Boolean(opts.json),
          dryRun: Boolean(opts.dryRun),
          includeWorkspace: opts.includeWorkspace as boolean,
        });
      });
    });
}
