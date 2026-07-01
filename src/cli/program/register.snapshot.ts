// Snapshot command registration for SQLite-safe snapshot artifacts.
import type { Command } from "commander";
import {
  snapshotCreateCommand,
  snapshotListCommand,
  snapshotRestoreCommand,
  snapshotVerifyCommand,
  type SnapshotCreateOptions,
  type SnapshotJsonOptions,
  type SnapshotRepositoryOptions,
  type SnapshotRestoreOptions,
} from "../../commands/snapshot.js";
import { defaultRuntime } from "../../runtime.js";
import { runCommandWithRuntime } from "../cli-utils.js";

/** Register snapshot create/list/verify/restore subcommands. */
export function registerSnapshotCommand(program: Command): void {
  const snapshot = program
    .command("snapshot")
    .description("Create, verify, list, and restore SQLite snapshots")
    .action(() => {
      snapshot.outputHelp();
      process.exitCode = 1;
    });

  snapshot
    .command("create")
    .description("Create a consistent SQLite snapshot in a local repository")
    .option("--db <path>", "SQLite database path")
    .option("--target <target>", "OpenClaw database target (global)")
    .option("--agent <id>", "OpenClaw agent id for the per-agent database")
    .requiredOption("--repository <path>", "Snapshot repository directory")
    .option("--id <id>", "Logical database id recorded in the manifest")
    .option("--kind <kind>", "Logical database kind recorded in the manifest")
    .option("--json", "Emit JSON output")
    .action(async (options: SnapshotCreateOptions) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        process.exitCode = await snapshotCreateCommand(options, defaultRuntime);
      });
    });

  snapshot
    .command("verify")
    .description("Verify a snapshot manifest, artifact hash, and SQLite integrity")
    .argument("<snapshot>", "Snapshot directory")
    .option("--json", "Emit JSON output")
    .action(async (snapshotPath: string, options: SnapshotJsonOptions) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        process.exitCode = await snapshotVerifyCommand(snapshotPath, options, defaultRuntime);
      });
    });

  snapshot
    .command("restore")
    .description("Restore a verified snapshot to a new SQLite database path")
    .argument("<snapshot>", "Snapshot directory")
    .requiredOption("--target <path>", "Target SQLite database path; must not already exist")
    .option("--json", "Emit JSON output")
    .action(async (snapshotPath: string, options: SnapshotRestoreOptions) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        process.exitCode = await snapshotRestoreCommand(snapshotPath, options, defaultRuntime);
      });
    });

  snapshot
    .command("list")
    .description("List snapshots in a local repository")
    .requiredOption("--repository <path>", "Snapshot repository directory")
    .option("--json", "Emit JSON output")
    .action(async (options: SnapshotRepositoryOptions) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        process.exitCode = await snapshotListCommand(options, defaultRuntime);
      });
    });
}
