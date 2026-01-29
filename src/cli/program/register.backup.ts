import type { Command } from "commander";
import {
  backupCreateCommand,
  backupExportCommand,
  backupRestoreCommand,
} from "../../commands/backup.js";
import { defaultRuntime } from "../../runtime.js";
import { theme } from "../../terminal/theme.js";
import { runCommandWithRuntime } from "../cli-utils.js";
import { formatHelpExamples } from "../help-format.js";

export function registerBackupCommands(program: Command) {
  const backup = program
    .command("backup")
    .description("Backup, restore, and export Moltbot data");

  backup
    .command("create")
    .description("Create a full backup of config, sessions, and memory")
    .option("--output <path>", "Output directory (default: ~/moltbot-backup-<timestamp>)")
    .option("--include-credentials", "Include API keys and tokens in backup", false)
    .option("--json", "Output result as JSON", false)
    .addHelpText(
      "after",
      () =>
        `\n${theme.heading("Examples:")}\n${formatHelpExamples([
          ["moltbot backup create", "Create backup in home directory."],
          ["moltbot backup create --output /tmp/backup", "Specify output directory."],
          ["moltbot backup create --include-credentials", "Include API keys."],
        ])}`,
    )
    .action(async (opts) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        await backupCreateCommand(
          {
            output: opts.output as string | undefined,
            includeCredentials: Boolean(opts.includeCredentials),
            json: Boolean(opts.json),
          },
          defaultRuntime,
        );
      });
    });

  backup
    .command("restore")
    .description("Restore from a backup directory")
    .argument("<path>", "Path to backup directory")
    .option("--dry-run", "Show what would be restored without making changes", false)
    .option("--json", "Output result as JSON", false)
    .addHelpText(
      "after",
      () =>
        `\n${theme.heading("Examples:")}\n${formatHelpExamples([
          ["moltbot backup restore ~/moltbot-backup-2024-01-15", "Restore from backup."],
          ["moltbot backup restore ~/backup --dry-run", "Preview restore without changes."],
        ])}`,
    )
    .action(async (inputPath, opts) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        await backupRestoreCommand(
          {
            input: String(inputPath),
            dryRun: Boolean(opts.dryRun),
            json: Boolean(opts.json),
          },
          defaultRuntime,
        );
      });
    });

  backup
    .command("export")
    .description("Export conversations as Markdown, JSON, or JSONL")
    .option("--format <format>", "Export format: markdown, json, jsonl", "markdown")
    .option("--output <path>", "Output file path")
    .option("--agent <id>", "Export only this agent's conversations")
    .option("--session <key>", "Export only this session")
    .option("--since <period>", "Only export messages after this time (e.g. 1h, 2d, 2024-01-01)")
    .addHelpText(
      "after",
      () =>
        `\n${theme.heading("Examples:")}\n${formatHelpExamples([
          ["moltbot backup export", "Export all conversations as Markdown."],
          ["moltbot backup export --format json", "Export as JSON."],
          ["moltbot backup export --agent pi --since 7d", "Last 7 days from pi agent."],
          ["moltbot backup export --format jsonl --output ./export.jsonl", "JSONL to file."],
        ])}`,
    )
    .action(async (opts) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        await backupExportCommand(
          {
            format: opts.format as "markdown" | "json" | "jsonl" | undefined,
            output: opts.output as string | undefined,
            agent: opts.agent as string | undefined,
            session: opts.session as string | undefined,
            since: opts.since as string | undefined,
          },
          defaultRuntime,
        );
      });
    });
}
