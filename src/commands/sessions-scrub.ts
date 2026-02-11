import { intro, outro, spinner } from "@clack/prompts";
import fs from "node:fs";
import type { RuntimeEnv } from "../runtime.js";
import { resolveStateDir } from "../config/paths.js";
import { findSessionFiles } from "../gateway/session-utils.fs.js";
import { redactSensitiveText } from "../logging/redact.js";
import { stylePromptTitle } from "../terminal/prompt-style.js";
import { theme } from "../terminal/theme.js";

const DEFAULT_CONCURRENCY = 20;

type ScrubOptions = {
  dryRun?: boolean;
  verbose?: boolean;
  noBackup?: boolean;
  concurrency?: number;
};

type ScrubResult = {
  filesScanned: number;
  filesModified: number;
  redactionCount: number;
  errors: number;
};

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
    // Apply redaction repeatedly until stable to catch patterns revealed by prior masking.
    // Track seen states to detect oscillation (non-idempotent patterns producing
    // alternating output). If detected, stop early — the line is as redacted as it can be.
    const MAX_PASSES = 10;
    let current = line;
    let lineRedacted = false;
    const seen = new Set<string>([current]);
    for (let pass = 0; pass < MAX_PASSES; pass++) {
      const redacted = redactSensitiveText(current, { mode: "tools" });
      if (redacted === current) {
        break; // stable — no further changes
      }
      if (seen.has(redacted)) {
        // Oscillation detected — output is cycling between states.
        // Use the shorter (more redacted) version and stop.
        current = redacted.length <= current.length ? redacted : current;
        lineRedacted = true;
        break;
      }
      seen.add(redacted);
      current = redacted;
      lineRedacted = true;
    }
    if (lineRedacted) {
      modified = true;
      redactionCount++;
    }
    return current;
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
    errors: 0,
  };

  const rawConcurrency = opts.concurrency ?? DEFAULT_CONCURRENCY;
  const concurrency =
    Number.isFinite(rawConcurrency) && rawConcurrency >= 1 ? rawConcurrency : DEFAULT_CONCURRENCY;

  spin.start(
    opts.dryRun ? "Scanning for secrets (dry run)..." : "Scrubbing secrets from sessions...",
  );

  // Process files with bounded concurrency
  let fileIndex = 0;

  async function processNext(): Promise<void> {
    while (fileIndex < files.length) {
      const idx = fileIndex++;
      const file = files[idx];
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
        result.errors++;
        const message = error instanceof Error ? error.message : String(error);
        if (opts.verbose) {
          runtime.error(`Failed to process ${file}: ${message}`);
        }
      }
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, files.length) }, () => processNext());
  await Promise.all(workers);

  spin.stop(opts.dryRun ? "Scan complete" : "Scrub complete");

  // Report results
  const lines: string[] = [];
  lines.push(`Files scanned: ${theme.info(String(result.filesScanned))}`);

  if (opts.dryRun) {
    lines.push(`Files that would be modified: ${theme.warn(String(result.filesModified))}`);
    lines.push(`Lines with secrets: ${theme.warn(String(result.redactionCount))}`);
    if (result.filesModified > 0) {
      lines.push("");
      lines.push(theme.muted("Run without --dry-run to apply changes. Backups will be created."));
    }
  } else {
    lines.push(`Files modified: ${theme.success(String(result.filesModified))}`);
    lines.push(`Lines scrubbed: ${theme.success(String(result.redactionCount))}`);
    if (result.filesModified > 0 && !opts.noBackup) {
      lines.push("");
      lines.push(theme.muted("Backups created with .bak extension."));
    }
  }

  if (result.errors > 0) {
    lines.push(`Errors: ${theme.warn(String(result.errors))} file(s) failed to process`);
  }

  runtime.log("");
  for (const line of lines) {
    runtime.log(line);
  }

  outro(opts.dryRun ? "Dry run complete" : "Sessions scrubbed");
}
