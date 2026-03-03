import fs from "node:fs";

/**
 * Tracks sessions that have undergone compaction and are pending a
 * post-compaction read audit on the next agent turn.
 * Keyed by sessionKey; value is true when audit is pending.
 */
export const pendingPostCompactionAudits = new Map<string, boolean>();

/**
 * Required startup file patterns to verify after compaction.
 * Each entry is a substring (case-insensitive) that should appear in
 * at least one file path read by the agent after compaction.
 */
const REQUIRED_READ_PATTERNS = ["WORKFLOW_AUTO.md", "MEMORY.md"];

/**
 * Reads raw session messages from a JSONL session file.
 * Returns an array of parsed message objects (assistant/user/tool).
 */
export function readSessionMessages(sessionFile: string): unknown[] {
  try {
    const lines = fs.readFileSync(sessionFile, "utf-8").split(/\r?\n/);
    const messages: unknown[] = [];
    for (const line of lines) {
      if (!line.trim()) {
        continue;
      }
      try {
        const parsed = JSON.parse(line);
        // Session JSONL entries have a "message" field for message records
        if (parsed?.message) {
          messages.push(parsed.message);
        }
      } catch {
        // Ignore malformed lines
      }
    }
    return messages;
  } catch {
    return [];
  }
}

/**
 * Extracts file paths that were read by the agent from a set of session messages.
 * Looks for tool_use blocks with name "read" and extracts the path/file_path input.
 */
export function extractReadPaths(messages: unknown[]): string[] {
  const paths: string[] = [];
  for (const message of messages) {
    if (!message || typeof message !== "object") {
      continue;
    }
    const msg = message as Record<string, unknown>;
    if (msg.role !== "assistant") {
      continue;
    }
    const content = msg.content;
    if (!Array.isArray(content)) {
      continue;
    }
    for (const block of content) {
      if (!block || typeof block !== "object") {
        continue;
      }
      const b = block as Record<string, unknown>;
      if (b.type !== "tool_use") {
        continue;
      }
      // Tool name may have surrounding whitespace in some model outputs
      const name = typeof b.name === "string" ? b.name.trim() : "";
      if (name !== "read") {
        continue;
      }
      const input = b.input;
      if (!input || typeof input !== "object") {
        continue;
      }
      const inp = input as Record<string, unknown>;
      // Read tool accepts "path" or "file_path" as the path key
      const filePath = inp.path ?? inp.file_path;
      if (typeof filePath === "string" && filePath) {
        paths.push(filePath);
      }
    }
  }
  return paths;
}

/**
 * Audits whether the agent read the required startup files after compaction.
 * Returns passed=true if all required patterns were covered, or false with
 * the list of missing pattern names.
 */
export function auditPostCompactionReads(
  readPaths: string[],
  _workspaceDir: string,
): { passed: boolean; missingPatterns: string[] } {
  const missingPatterns: string[] = [];
  for (const pattern of REQUIRED_READ_PATTERNS) {
    const found = readPaths.some((p) => p.toLowerCase().includes(pattern.toLowerCase()));
    if (!found) {
      missingPatterns.push(pattern);
    }
  }
  return { passed: missingPatterns.length === 0, missingPatterns };
}

/**
 * Formats a warning message for missing post-compaction reads.
 */
export function formatAuditWarning(missingPatterns: string[]): string {
  const list = missingPatterns.map((p) => `- ${p}`).join("\n");
  return (
    "[Post-compaction audit warning]\n\n" +
    "The agent did not read the following required startup files after context compaction:\n\n" +
    list +
    "\n\nPlease read these files now to restore required context before responding."
  );
}
