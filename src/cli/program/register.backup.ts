import type { Command } from "commander";
import { backupListCommand } from "../../commands/backup-list.js";
import { backupRestoreCommand } from "../../commands/backup-restore.js";
import { backupRunCommand } from "../../commands/backup-run.js";
import { backupStatusCommand } from "../../commands/backup-status.js";
import { backupVerifyCommand } from "../../commands/backup-verify.js";
import { backupCreateCommand } from "../../commands/backup.js";
import { workspaceBackupInitCommand } from "../../commands/workspace-backup.js";
import { defaultRuntime } from "../../runtime.js";
import { formatDocsLink } from "../../terminal/links.js";
import { theme } from "../../terminal/theme.js";
import { runCommandWithRuntime } from "../cli-utils.js";
import { formatHelpExamples } from "../help-format.js";

type ArchiveCommandCliOptions = {
  output?: string;
  json?: boolean;
  dryRun?: boolean;
  verify?: boolean;
  onlyConfig?: boolean;
  includeWorkspace?: boolean;
};

type SnapshotRunCliOptions = {
  output?: string;
  json?: boolean;
  verify?: boolean;
  snapshotName?: string;
};

function logDeprecatedCommand(oldCommand: string, replacement: string) {
  defaultRuntime.log(theme.warn(`\`${oldCommand}\` is deprecated; use \`${replacement}\`.`));
}

function addArchiveCommandOptions(command: Command): Command {
  return command
    .option("--output <path>", "Archive path or destination directory")
    .option("--json", "Output JSON", false)
    .option("--dry-run", "Print the backup plan without writing the archive", false)
    .option("--verify", "Verify the archive after writing it", false)
    .option("--only-config", "Back up only the active JSON config file", false)
    .option("--no-include-workspace", "Exclude workspace directories from the backup");
}

async function runArchiveCommand(
  opts: ArchiveCommandCliOptions,
  deprecated?: { oldCommand: string; replacement: string },
) {
  await runCommandWithRuntime(defaultRuntime, async () => {
    if (deprecated && !opts.json) {
      logDeprecatedCommand(deprecated.oldCommand, deprecated.replacement);
    }
    await backupCreateCommand(defaultRuntime, {
      output: opts.output,
      json: Boolean(opts.json),
      dryRun: Boolean(opts.dryRun),
      verify: Boolean(opts.verify),
      onlyConfig: Boolean(opts.onlyConfig),
      includeWorkspace: opts.includeWorkspace as boolean,
    });
  });
}

function addSnapshotRunOptions(command: Command): Command {
  return command
    .option("--output <path>", "Keep the intermediate local archive at this path or directory")
    .option("--json", "Output JSON", false)
    .option("--verify", "Verify the local archive before copying the encrypted snapshot", false)
    .option("--snapshot-name <name>", "Optional label for this snapshot");
}

async function runSnapshotCommand(
  opts: SnapshotRunCliOptions,
  params?: {
    mode?: "snapshot";
    deprecated?: { oldCommand: string; replacement: string };
  },
) {
  await runCommandWithRuntime(defaultRuntime, async () => {
    if (params?.deprecated && !opts.json) {
      logDeprecatedCommand(params.deprecated.oldCommand, params.deprecated.replacement);
    }
    await backupRunCommand(defaultRuntime, {
      output: opts.output,
      json: Boolean(opts.json),
      verify: Boolean(opts.verify),
      snapshotName: opts.snapshotName,
      mode: params?.mode,
    });
  });
}

export function registerBackupCommand(program: Command) {
  const backup = program
    .command("backup")
    .description("Set up, run, inspect, export, and restore backups")
    .addHelpText(
      "after",
      () =>
        `\n${theme.muted("Docs:")} ${formatDocsLink("/cli/backup", "docs.openclaw.ai/cli/backup")}\n`,
    );

  backup
    .command("setup")
    .description("Detect a cloud drive folder and save it as the backup target")
    .option("--target <path>", "Override the detected backup directory")
    .option("--json", "Output JSON", false)
    .addHelpText(
      "after",
      () =>
        `\n${theme.heading("Examples:")}\n${formatHelpExamples([
          ["openclaw backup setup", "Detect a default cloud drive folder and save it."],
          [
            "openclaw backup setup --target ~/Dropbox/OpenClaw Backups",
            "Use a specific cloud drive backup directory.",
          ],
        ])}`,
    )
    .action(async (opts) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        await workspaceBackupInitCommand(defaultRuntime, {
          target: opts.target as string | undefined,
          json: Boolean(opts.json),
        });
      });
    });

  const runCommand = addSnapshotRunOptions(
    backup.command("run").description("Run the configured backup flow"),
  );
  runCommand
    .addHelpText(
      "after",
      () =>
        `\n${theme.heading("Examples:")}\n${formatHelpExamples([
          ["openclaw backup run", "Run the primary backup flow for the current config."],
          [
            "openclaw backup run --snapshot-name nightly",
            "Create a labeled encrypted snapshot when full backup is enabled.",
          ],
        ])}`,
    )
    .action(async (opts) => {
      await runSnapshotCommand({
        output: opts.output as string | undefined,
        json: Boolean(opts.json),
        verify: Boolean(opts.verify),
        snapshotName: opts.snapshotName as string | undefined,
      });
    });

  backup
    .command("status")
    .description("Show workspace backup status and the latest full backup snapshot")
    .option("--json", "Output JSON", false)
    .action(async (opts) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        await backupStatusCommand(defaultRuntime, {
          json: Boolean(opts.json),
        });
      });
    });

  const archiveExamples = () =>
    `\n${theme.heading("Examples:")}\n${formatHelpExamples([
      ["openclaw backup export", "Create a timestamped backup in the current directory."],
      [
        "openclaw backup export --output ~/Backups",
        "Write the archive into an existing backup directory.",
      ],
      [
        "openclaw backup export --dry-run --json",
        "Preview the archive plan without writing any files.",
      ],
      [
        "openclaw backup export --verify",
        "Create the archive and immediately validate its manifest and payload layout.",
      ],
      [
        "openclaw backup export --no-include-workspace",
        "Back up state/config without agent workspace files.",
      ],
      ["openclaw backup export --only-config", "Back up only the active JSON config file."],
    ])}`;

  const exportCommand = addArchiveCommandOptions(
    backup
      .command("export")
      .description("Write a backup archive for config, credentials, sessions, and workspaces"),
  );
  exportCommand.addHelpText("after", archiveExamples).action(async (opts) => {
    await runArchiveCommand({
      output: opts.output as string | undefined,
      json: Boolean(opts.json),
      dryRun: Boolean(opts.dryRun),
      verify: Boolean(opts.verify),
      onlyConfig: Boolean(opts.onlyConfig),
      includeWorkspace: opts.includeWorkspace as boolean,
    });
  });

  const createAliasCommand = addArchiveCommandOptions(
    backup.command("create").description("Deprecated alias for `backup export`"),
  );
  createAliasCommand.action(async (opts) => {
    await runArchiveCommand(
      {
        output: opts.output as string | undefined,
        json: Boolean(opts.json),
        dryRun: Boolean(opts.dryRun),
        verify: Boolean(opts.verify),
        onlyConfig: Boolean(opts.onlyConfig),
        includeWorkspace: opts.includeWorkspace as boolean,
      },
      {
        oldCommand: "backup create",
        replacement: "backup export",
      },
    );
  });

  const pushAliasCommand = addSnapshotRunOptions(
    backup
      .command("push")
      .description("Create an encrypted backup snapshot in the configured backup folder"),
  );
  pushAliasCommand.action(async (opts) => {
    await runSnapshotCommand(
      {
        output: opts.output as string | undefined,
        json: Boolean(opts.json),
        verify: Boolean(opts.verify),
        snapshotName: opts.snapshotName as string | undefined,
      },
      {
        mode: "snapshot",
        deprecated: {
          oldCommand: "backup push",
          replacement: "backup run",
        },
      },
    );
  });

  backup
    .command("verify <archive>")
    .description("Validate a backup archive and its embedded manifest")
    .option("--json", "Output JSON", false)
    .addHelpText(
      "after",
      () =>
        `\n${theme.heading("Examples:")}\n${formatHelpExamples([
          [
            "openclaw backup verify ./2026-03-09T00-00-00.000Z-openclaw-backup.tar.gz",
            "Check that the archive structure and manifest are intact.",
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
    .command("list")
    .description("List encrypted backup snapshots for the current installation")
    .option("--json", "Output JSON", false)
    .action(async (opts) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        await backupListCommand(defaultRuntime, {
          json: Boolean(opts.json),
        });
      });
    });

  backup
    .command("restore [snapshotId]")
    .description(
      "Restore a local archive or encrypted backup snapshot into the current installation",
    )
    .option("--archive <path>", "Restore from a local backup archive instead of backup snapshot")
    .option("--installation-id <id>", "Override the installation id used to locate snapshots")
    .option("--mode <mode>", "Restore scope: full-host (default), config-only, or workspace-only")
    .option("--force-stop", "Stop the gateway service before restoring", false)
    .option("--json", "Output JSON", false)
    .action(async (snapshotId, opts) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        await backupRestoreCommand(defaultRuntime, {
          snapshotId: typeof snapshotId === "string" ? snapshotId : undefined,
          archive: opts.archive as string | undefined,
          installationId: opts.installationId as string | undefined,
          mode: opts.mode as "full-host" | "config-only" | "workspace-only" | undefined,
          forceStop: Boolean(opts.forceStop),
          json: Boolean(opts.json),
        });
      });
    });
}
