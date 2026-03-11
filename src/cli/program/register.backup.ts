import type { Command } from "commander";
import {
  backupListCommand,
  chooseBackupArchiveForRestore,
  resolveLatestBackupArchiveForRestore,
} from "../../commands/backup-catalog.js";
import { backupRestoreCommand } from "../../commands/backup-restore.js";
import { backupVerifyCommand } from "../../commands/backup-verify.js";
import { backupCreateCommand } from "../../commands/backup.js";
import { defaultRuntime } from "../../runtime.js";
import { formatDocsLink } from "../../terminal/links.js";
import { theme } from "../../terminal/theme.js";
import { runCommandWithRuntime } from "../cli-utils.js";
import { formatHelpExamples } from "../help-format.js";

export function registerBackupCommand(program: Command) {
  const backup = program
    .command("backup")
    .description("Create and validate local OpenClaw backup archives")
    .addHelpText(
      "after",
      () =>
        `\n${theme.muted("Docs:")} ${formatDocsLink("/cli/backup", "docs.openclaw.ai/cli/backup")}\n`,
    );

  backup
    .command("create")
    .description(
      "Create a validated backup archive for config, credentials, sessions, and workspaces",
    )
    .option("--output <path>", "Archive path or destination directory")
    .option("--json", "Output JSON", false)
    .option("--dry-run", "Print the backup plan without writing the archive", false)
    .option("--only-config", "Back up only the active JSON config file", false)
    .option("--no-include-workspace", "Exclude workspace directories from the backup")
    .addHelpText(
      "after",
      () =>
        `\n${theme.heading("Examples:")}\n${formatHelpExamples([
          [
            "openclaw backup create",
            "Create and validate a timestamped backup in the current directory.",
          ],
          [
            "openclaw backup create --output ~/Backups",
            "Write and validate the archive inside an existing backup directory.",
          ],
          [
            "openclaw backup create --dry-run --json",
            "Preview the archive plan without writing any files.",
          ],
          [
            "openclaw backup create --no-include-workspace",
            "Back up state/config without agent workspace files.",
          ],
          ["openclaw backup create --only-config", "Back up only the active JSON config file."],
        ])}`,
    )
    .action(async (opts) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        await backupCreateCommand(defaultRuntime, {
          output: opts.output as string | undefined,
          json: Boolean(opts.json),
          dryRun: Boolean(opts.dryRun),
          verify: true,
          onlyConfig: Boolean(opts.onlyConfig),
          includeWorkspace: opts.includeWorkspace as boolean,
        });
      });
    });

  backup
    .command("list [path]")
    .description("List validated backup archive versions in a directory")
    .option("--json", "Output JSON", false)
    .addHelpText(
      "after",
      () =>
        `\n${theme.heading("Examples:")}\n${formatHelpExamples([
          [
            "openclaw backup list",
            "List validated backup archives from the current directory and ~/Backups.",
          ],
          [
            "openclaw backup list ~/Backups --json",
            "Emit machine-readable backup version metadata for a backup directory.",
          ],
        ])}`,
    )
    .action(async (listPath, opts) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        await backupListCommand(defaultRuntime, {
          path: listPath as string | undefined,
          json: Boolean(opts.json),
        });
      });
    });

  backup
    .command("verify <archive>")
    .description("Re-validate an existing backup archive and its embedded manifest")
    .option("--json", "Output JSON", false)
    .addHelpText(
      "after",
      () =>
        `\n${theme.heading("Examples:")}\n${formatHelpExamples([
          [
            "openclaw backup verify ./2026-03-09T00-00-00.000Z-openclaw-backup.tar.gz",
            "Re-check that an existing archive's structure and manifest are intact.",
          ],
          [
            "openclaw backup verify ~/Backups/latest.tar.gz --json",
            "Emit machine-readable verification output.",
          ],
        ])}`,
    )
    .action(async (archive, opts) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        await backupVerifyCommand(defaultRuntime, {
          archive: archive as string,
          json: Boolean(opts.json),
        });
      });
    });

  backup
    .command("restore [archive]")
    .description("Restore the latest or a selected backup archive into the current OpenClaw paths")
    .option("--json", "Output JSON", false)
    .option("--dry-run", "Preview restore targets without writing any files", false)
    .option("--force", "Replace existing restore targets", false)
    .option("--choose [path]", "Choose a validated backup version from a directory")
    .option("--no-include-workspace", "Skip restoring external workspace directories")
    .addHelpText(
      "after",
      () =>
        `\n${theme.heading("Examples:")}\n${formatHelpExamples([
          [
            "openclaw backup restore",
            "Restore the latest validated backup found in the current directory or ~/Backups.",
          ],
          [
            "openclaw backup restore ./2026-03-09T00-00-00.000Z-openclaw-backup.tar.gz",
            "Restore a validated backup archive to the current OpenClaw paths.",
          ],
          [
            "openclaw backup restore ~/Backups/latest.tar.gz --dry-run",
            "Preview which paths would be restored before writing anything.",
          ],
          [
            "openclaw backup restore ~/Backups/latest.tar.gz --force --no-include-workspace",
            "Replace existing state/config/credentials while skipping external workspaces.",
          ],
          [
            "openclaw backup restore --choose",
            "Choose a backup version from the current directory or ~/Backups, then restore it.",
          ],
          [
            "openclaw backup restore --choose ~/Backups --dry-run",
            "Choose a backup version from a directory and preview its restore targets.",
          ],
        ])}`,
    )
    .action(async (archive, opts) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        if (archive && opts.choose) {
          throw new Error("Pass either <archive> or --choose, not both.");
        }
        const resolvedArchive =
          typeof archive === "string" && archive.trim()
            ? archive
            : opts.choose
              ? await chooseBackupArchiveForRestore({
                  runtime: defaultRuntime,
                  searchPath: typeof opts.choose === "string" ? opts.choose : undefined,
                })
              : await resolveLatestBackupArchiveForRestore({});
        await backupRestoreCommand(defaultRuntime, {
          archive: resolvedArchive,
          json: Boolean(opts.json),
          dryRun: Boolean(opts.dryRun),
          force: Boolean(opts.force),
          includeWorkspace: opts.includeWorkspace as boolean,
        });
      });
    });
}
