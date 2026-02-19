import fs from "node:fs";
import path from "node:path";

// Default required files — constants, extensible to config later
const DEFAULT_REQUIRED_READS: Array<string | RegExp> = [
  "WORKFLOW_AUTO.md",
  /memory\/\d{4}-\d{2}-\d{2}\.md/, // daily memory files
];

/**
 * Audit whether agent read required startup files after compaction.
 * Returns list of missing file patterns.
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

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function extractPathArg(args: unknown): string | null {
  if (!isObjectRecord(args)) {
    return null;
  }
  const value = args.file_path ?? args.path;
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function extractReadPathFromContentBlock(block: unknown): string | null {
  if (!isObjectRecord(block) || block.name !== "read") {
    return null;
  }

  // BUG-045: session transcripts can contain legacy tool_use and newer toolCall shapes.
  if (block.type === "tool_use") {
    return extractPathArg(block.input);
  }
  if (block.type === "toolCall") {
    return extractPathArg(block.arguments) ?? extractPathArg(block.input);
  }
  return null;
}

/**
 * Extract file paths from Read tool calls in agent messages.
 * Supports both legacy tool_use blocks and OpenAI/Codex toolCall blocks.
 */
export function extractReadPaths(messages: Array<{ role?: string; content?: unknown }>): string[] {
  const paths: string[] = [];
  const seen = new Set<string>();

  for (const msg of messages) {
    if (msg.role !== "assistant" || !Array.isArray(msg.content)) {
      continue;
    }

    for (const block of msg.content) {
      const filePath = extractReadPathFromContentBlock(block);
      if (filePath && !seen.has(filePath)) {
        seen.add(filePath);
        paths.push(filePath);
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
