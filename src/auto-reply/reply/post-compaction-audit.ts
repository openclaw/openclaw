import fs from "node:fs";
import path from "node:path";

// Default required files — constants, extensible to config later.
// Only files that actually exist in the workspace are required.
// WORKFLOW_AUTO.md was removed as a hardcoded default because most
// workspaces don't use it, causing perpetual missing-file warnings
// after compaction (see #22674).
const DEFAULT_REQUIRED_READS: Array<string | RegExp> = [
  /memory\/\d{4}-\d{2}-\d{2}\.md/, // daily memory files
];

/**
 * Resolve the effective required-reads list by filtering out string entries
 * that don't exist on disk. RegExp entries are kept as-is (they match
 * against what the agent actually read, not what exists on disk).
 */
function resolveEffectiveRequiredReads(
  requiredReads: Array<string | RegExp>,
  workspaceDir: string,
): Array<string | RegExp> {
  return requiredReads.filter((entry) => {
    if (typeof entry === "string") {
      const resolved = path.resolve(workspaceDir, entry);
      return fs.existsSync(resolved);
    }
    // RegExp entries are always kept — they match against read paths.
    return true;
  });
}

/**
 * Audit whether agent read required startup files after compaction.
 * Returns list of missing file patterns.
 *
 * String entries in requiredReads are only enforced when the file exists
 * in the workspace. This prevents perpetual warnings for files that the
 * user never created (e.g. WORKFLOW_AUTO.md). RegExp entries always apply
 * but only flag "missing" if matching files were not read — not if they
 * don't exist.
 */
export function auditPostCompactionReads(
  readFilePaths: string[],
  workspaceDir: string,
  requiredReads: Array<string | RegExp> = DEFAULT_REQUIRED_READS,
): { passed: boolean; missingPatterns: string[] } {
  const effective = resolveEffectiveRequiredReads(requiredReads, workspaceDir);
  const normalizedReads = readFilePaths.map((p) => path.resolve(workspaceDir, p));
  const missingPatterns: string[] = [];

  for (const required of effective) {
    if (typeof required === "string") {
      const requiredResolved = path.resolve(workspaceDir, required);
      const found = normalizedReads.some((r) => r === requiredResolved);
      if (!found) {
        missingPatterns.push(required);
      }
    } else {
      // RegExp — match against relative paths from workspace
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
