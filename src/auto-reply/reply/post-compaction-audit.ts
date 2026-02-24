import fs from "node:fs";
import path from "node:path";

// Default required files — constants, extensible to config later
const DEFAULT_REQUIRED_READS: Array<string | RegExp> = [];

/**
 * Check whether any files matching a RegExp pattern exist under a directory.
 * Performs a bounded recursive scan (max depth 3) to avoid perf issues.
 */
function hasFilesMatchingPattern(dir: string, pattern: RegExp, maxDepth = 3): boolean {
  if (maxDepth < 0) {
    return false;
  }
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const entry of entries) {
    const rel = path.relative(dir, path.join(dir, entry.name));
    if (entry.isFile()) {
      const normalizedRel = rel.split(path.sep).join("/");
      if (pattern.test(normalizedRel)) {
        return true;
      }
    } else if (entry.isDirectory() && !entry.name.startsWith(".")) {
      const subDir = path.join(dir, entry.name);
      // Check recursively, adjusting pattern to match from workspace root
      if (hasFilesMatchingPatternFromRoot(subDir, pattern, dir, maxDepth - 1)) {
        return true;
      }
    }
  }
  return false;
}

/** Recursive helper that matches relative paths from the workspace root. */
function hasFilesMatchingPatternFromRoot(
  dir: string,
  pattern: RegExp,
  workspaceDir: string,
  maxDepth: number,
): boolean {
  if (maxDepth < 0) {
    return false;
  }
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    const rel = path.relative(workspaceDir, fullPath).split(path.sep).join("/");
    if (entry.isFile() && pattern.test(rel)) {
      return true;
    }
    if (entry.isDirectory() && !entry.name.startsWith(".")) {
      if (hasFilesMatchingPatternFromRoot(fullPath, pattern, workspaceDir, maxDepth - 1)) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Audit whether agent read required startup files after compaction.
 * Returns list of missing file patterns.
 * Skips any required file/pattern that doesn't actually exist on disk.
 */
export function auditPostCompactionReads(
  readFilePaths: string[],
  workspaceDir: string,
  requiredReads: Array<string | RegExp> = DEFAULT_REQUIRED_READS,
): { passed: boolean; missingPatterns: string[] } {
  const normalizedReads = readFilePaths.map((p) => path.resolve(workspaceDir, p));
  const missingPatterns: string[] = [];

  for (const required of requiredReads) {
    if (typeof required === "string") {
      const requiredResolved = path.resolve(workspaceDir, required);
      if (!fs.existsSync(requiredResolved)) {
        continue; // Don't require reading a file that doesn't exist
      }
      const found = normalizedReads.some((r) => r === requiredResolved);
      if (!found) {
        missingPatterns.push(required);
      }
    } else {
      // RegExp — skip if no matching files exist in workspace
      if (!hasFilesMatchingPattern(workspaceDir, required)) {
        continue;
      }
      // Match against relative paths from workspace
      const found = readFilePaths.some((p) => {
        const rel = path.relative(workspaceDir, path.resolve(workspaceDir, p));
        // Normalize to forward slashes for cross-platform RegExp matching
        const normalizedRel = rel.split(path.sep).join("/");
        return required.test(normalizedRel);
      });
      if (!found) {
        missingPatterns.push(required.source);
      }
    }
  }

  return { passed: missingPatterns.length === 0, missingPatterns };
}

/**
 * Read messages from a session JSONL file.
 * Returns messages from the last N lines (default 100).
 */
export function readSessionMessages(
  sessionFile: string,
  maxLines = 100,
): Array<{ role?: string; content?: unknown }> {
  if (!fs.existsSync(sessionFile)) {
    return [];
  }

  try {
    const content = fs.readFileSync(sessionFile, "utf-8");
    const lines = content.trim().split("\n");
    const recentLines = lines.slice(-maxLines);

    const messages: Array<{ role?: string; content?: unknown }> = [];
    for (const line of recentLines) {
      try {
        const entry = JSON.parse(line);
        if (entry.type === "message" && entry.message) {
          messages.push(entry.message);
        }
      } catch {
        // Skip malformed lines
      }
    }
    return messages;
  } catch {
    return [];
  }
}

/**
 * Extract file paths from Read tool calls in agent messages.
 * Looks for tool_use blocks with name="read" and extracts path/file_path args.
 */
export function extractReadPaths(messages: Array<{ role?: string; content?: unknown }>): string[] {
  const paths: string[] = [];
  for (const msg of messages) {
    if (msg.role !== "assistant" || !Array.isArray(msg.content)) {
      continue;
    }
    for (const block of msg.content) {
      if (block.type === "tool_use" && block.name === "read") {
        const filePath = block.input?.file_path ?? block.input?.path;
        if (typeof filePath === "string") {
          paths.push(filePath);
        }
      }
    }
  }
  return paths;
}

/** Format the audit warning message */
export function formatAuditWarning(missingPatterns: string[]): string {
  const fileList = missingPatterns.map((p) => `  - ${p}`).join("\n");
  return (
    "⚠️ Post-Compaction Audit: The following required startup files were not read after context reset:\n" +
    fileList +
    "\n\nPlease read them now using the Read tool before continuing. " +
    "This ensures your operating protocols are restored after memory compaction."
  );
}
