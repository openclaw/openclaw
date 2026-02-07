import { intro, outro, spinner } from "@clack/prompts";
import fs from "node:fs";
import path from "node:path";
import type { RuntimeEnv } from "../runtime.js";
import { resolveStateDir } from "../config/paths.js";
import { redactSensitiveText } from "../logging/redact.js";
import { stylePromptTitle } from "../terminal/prompt-style.js";
import { theme } from "../terminal/theme.js";

type ScrubOptions = {
  dryRun?: boolean;
  verbose?: boolean;
  noBackup?: boolean;
};

type ScrubResult = {
  filesScanned: number;
  filesModified: number;
  redactionCount: number;
};

async function findSessionFiles(stateDir: string): Promise<string[]> {
  const agentsDir = path.join(stateDir, "agents");
  if (!fs.existsSync(agentsDir)) {
    return [];
  }

  const files: string[] = [];
  const agentDirs = await fs.promises.readdir(agentsDir, { withFileTypes: true });

  for (const agentDir of agentDirs) {
    if (!agentDir.isDirectory()) {
      continue;
    }
    const sessionsDir = path.join(agentsDir, agentDir.name, "sessions");
    if (!fs.existsSync(sessionsDir)) {
      continue;
    }

    const sessionFiles = await fs.promises.readdir(sessionsDir);
    for (const file of sessionFiles) {
      if (file.endsWith(".jsonl")) {
        files.push(path.join(sessionsDir, file));
      }
    }
  }

  return files;
}

async function scrubSessionFile(
  filePath: string,
  opts: ScrubOptions,
): Promise<{ modified: boolean; redactionCount: number }> {
  const content = await fs.promises.readFile(filePath, "utf-8");
  const lines = content.split("\n");
  let modified = false;
  let redactionCount = 0;

  const scrubbedLines = lines.map((line) => {
    if (!line.trim()) {
      return line;
    }
    const redacted = redactSensitiveText(line, { mode: "tools" });
    if (redacted !== line) {
      modified = true;
      redactionCount++;
    }
    return redacted;
  });

  if (modified && !opts.dryRun) {
    // Create backup if not disabled
    if (!opts.noBackup) {
      const backupPath = `${filePath}.bak`;
      await fs.promises.copyFile(filePath, backupPath);
    }

    // Write scrubbed content
    await fs.promises.writeFile(filePath, scrubbedLines.join("\n"), "utf-8");
  }

  return { modified, redactionCount };
}

export async function sessionsScrubCommand(
  runtime: RuntimeEnv,
  opts: ScrubOptions = {},
): Promise<void> {
  intro(stylePromptTitle("Sessions Scrub") ?? "Sessions Scrub");

  const stateDir = resolveStateDir();
  const spin = spinner();

  spin.start("Finding session files...");
  const files = await findSessionFiles(stateDir);
  spin.stop(`Found ${files.length} session file(s)`);

  if (files.length === 0) {
    runtime.log(theme.muted("No session files found."));
    outro(opts.dryRun ? "Dry run complete" : "Complete");
    return;
  }

  const result: ScrubResult = {
    filesScanned: 0,
    filesModified: 0,
    redactionCount: 0,
  };

  spin.start(
    opts.dryRun ? "Scanning for secrets (dry run)..." : "Scrubbing secrets from sessions...",
  );

  for (const file of files) {
    result.filesScanned++;
    try {
      const { modified, redactionCount } = await scrubSessionFile(file, opts);
      if (modified) {
        result.filesModified++;
        result.redactionCount += redactionCount;
        if (opts.verbose) {
          const action = opts.dryRun ? "Would scrub" : "Scrubbed";
          runtime.log(theme.muted(`${action}: ${file} (${redactionCount} redaction(s))`));
        }
      }
    } catch (error) {
      if (opts.verbose) {
        const message = error instanceof Error ? error.message : String(error);
        runtime.error(`Failed to process ${file}: ${message}`);
      }
    }
  }

  spin.stop(opts.dryRun ? "Scan complete" : "Scrub complete");

  // Report results
  const lines: string[] = [];
  lines.push(`Files scanned: ${theme.info(String(result.filesScanned))}`);

  if (opts.dryRun) {
    lines.push(`Files that would be modified: ${theme.warn(String(result.filesModified))}`);
    lines.push(`Approximate redaction count: ${theme.warn(String(result.redactionCount))}`);
    if (result.filesModified > 0) {
      lines.push("");
      lines.push(theme.muted("Run without --dry-run to apply changes. Backups will be created."));
    }
  } else {
    lines.push(`Files modified: ${theme.success(String(result.filesModified))}`);
    lines.push(`Secrets redacted: ${theme.success(String(result.redactionCount))}`);
    if (result.filesModified > 0 && !opts.noBackup) {
      lines.push("");
      lines.push(theme.muted("Backups created with .bak extension."));
    }
  }

  runtime.log("");
  for (const line of lines) {
    runtime.log(line);
  }

  outro(opts.dryRun ? "Dry run complete" : "Sessions scrubbed");
}
