/**
 * CLI commands for managing tracked workspace documents.
 * `openclaw workspace-docs history <file>`
 * `openclaw workspace-docs diff <file> <sha>`
 * `openclaw workspace-docs show <file> <sha>`
 * `openclaw workspace-docs rollback <file> --to <sha>`
 */

import type { Command } from "commander";
import { getDocAtCommit, getDocDiff, getDocHistory, rollbackDoc } from "../agents/tracked-docs.js";
import { resolveDefaultAgentWorkspaceDir } from "../agents/workspace.js";
import { colorize, isRich } from "../terminal/theme.js";

function resolveWorkspaceDir(options: { workspace?: string }): string {
  return options.workspace?.trim() || resolveDefaultAgentWorkspaceDir();
}

function printHeader(text: string): void {
  if (isRich()) {
    console.log(colorize("bold", text));
  } else {
    console.log(text);
  }
}

export function registerWorkspaceDocsCommands(program: Command): void {
  const docs = program
    .command("workspace-docs")
    .alias("wdocs")
    .description("Manage tracked workspace document history (AGENTS.md, SOUL.md, etc.)");

  docs
    .command("history <filename>")
    .description("List commits that changed a workspace document")
    .option("-w, --workspace <dir>", "Workspace directory")
    .option("-n, --limit <n>", "Max commits to show", "20")
    .action(async (filename: string, options: { workspace?: string; limit?: string }) => {
      const workspaceDir = resolveWorkspaceDir(options);
      const limit = parseInt(options.limit ?? "20", 10);
      const history = await getDocHistory({ workspaceDir, filename, limit });

      if (history.length === 0) {
        console.log(`No tracked history found for ${filename}.`);
        console.log(
          `Hint: use \`openclaw workspace-docs write\` or ensure workspace has a git repo.`,
        );
        return;
      }

      printHeader(`\n${filename} — ${history.length} commit(s)\n`);
      for (const commit of history) {
        const sha = commit.sha.slice(0, 8).padEnd(10);
        const date = commit.date.slice(0, 16).padEnd(18);
        const subject = commit.subject;
        console.log(`  ${sha}  ${date}  ${subject}`);
        if (commit.body) {
          for (const line of commit.body.split("\n")) {
            if (line.trim()) {
              console.log(`              ${line}`);
            }
          }
        }
      }
      console.log();
    });

  docs
    .command("diff <filename> <sha>")
    .description("Show diff for a workspace document between a commit and HEAD (or --to)")
    .option("-w, --workspace <dir>", "Workspace directory")
    .option("--to <sha>", "Target commit (default: working tree)")
    .action(async (filename: string, sha: string, options: { workspace?: string; to?: string }) => {
      const workspaceDir = resolveWorkspaceDir(options);
      const diff = await getDocDiff({ workspaceDir, filename, fromSha: sha, toSha: options.to });
      if (!diff.trim()) {
        console.log(
          `No differences found for ${filename} between ${sha} and ${options.to ?? "working tree"}.`,
        );
        return;
      }
      console.log(diff);
    });

  docs
    .command("show <filename> <sha>")
    .description("Print the content of a workspace document at a specific commit")
    .option("-w, --workspace <dir>", "Workspace directory")
    .action(async (filename: string, sha: string, options: { workspace?: string }) => {
      const workspaceDir = resolveWorkspaceDir(options);
      const content = await getDocAtCommit({ workspaceDir, filename, sha });
      if (content === null) {
        console.error(`Could not find ${filename} at commit ${sha}.`);
        process.exitCode = 1;
        return;
      }
      process.stdout.write(content);
    });

  docs
    .command("rollback <filename>")
    .description("Roll back a workspace document to a prior commit (creates a new rollback commit)")
    .requiredOption("--to <sha>", "Commit SHA to roll back to")
    .option("-w, --workspace <dir>", "Workspace directory")
    .option("--reason <text>", "Reason for rollback (appended to commit message)")
    .action(
      async (filename: string, options: { workspace?: string; to: string; reason?: string }) => {
        const workspaceDir = resolveWorkspaceDir(options);
        const result = await rollbackDoc({
          workspaceDir,
          filename,
          sha: options.to,
          sessionKey: "cli",
          agentLabel: "openclaw-cli",
        });

        if (result.warning) {
          console.error(`Warning: ${result.warning}`);
        }

        if (result.committed) {
          console.log(
            `✓ Rolled back ${filename} to ${options.to} (new commit: ${result.sha ?? "unknown"})`,
          );
        } else {
          console.log(`Nothing to roll back — content at ${options.to} is already current.`);
        }
      },
    );
}
