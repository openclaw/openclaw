import fs from "node:fs";
import path from "node:path";
import type { OpenClawConfig } from "../../config/config.js";

export const DEFAULT_REQUIRED_READS: (string | RegExp)[] = [
  "WORKFLOW_AUTO.md",
  /memory\/\d{4}-\d{2}-\d{2}\.md/,
];

/**
 * Resolve the effective required reads list from config.
 * If hooks.postCompactionAudit.requiredReads is configured, use it (overrides defaults).
 * Otherwise fall back to DEFAULT_REQUIRED_READS.
 */
export function resolveRequiredReads(cfg?: OpenClawConfig): (string | RegExp)[] {
  const configured = cfg?.hooks?.postCompactionAudit?.requiredReads;
  if (!configured || configured.length === 0) {
    return DEFAULT_REQUIRED_READS;
  }
  return configured.flatMap((entry) => {
    if (entry.startsWith("/") && entry.endsWith("/")) {
      // Treat slash-wrapped strings as regex: "/memory\/\d+\.md/"
      try {
        return [new RegExp(entry.slice(1, -1))];
      } catch {
        // Malformed regex — skip rather than silently disabling the whole audit
        return [];
      }
    }
    return [entry];
  });
}

/**
 * Check whether post-compaction audit is enabled.
 * Defaults to false — opt-in only, since default requiredReads reference
 * WORKFLOW_AUTO.md which many workspaces don't use.
 */
export function isPostCompactionAuditEnabled(cfg?: OpenClawConfig): boolean {
  return cfg?.hooks?.postCompactionAudit?.enabled === true;
}

/**
 * Audit whether agent read required startup files after compaction.
 * Returns list of missing file patterns.
 */
export function auditPostCompactionReads(
  readFilePaths: string[],
  workspaceDir: string,
  requiredReads: (string | RegExp)[] = DEFAULT_REQUIRED_READS,
): { passed: boolean; missingPatterns: string[] } {
  const normalizedReads = readFilePaths.map((p) => path.resolve(workspaceDir, p));
  const missingPatterns: string[] = [];

  for (const required of requiredReads) {
    if (typeof required === "string") {
      const requiredResolved = path.resolve(workspaceDir, required);
      if (!normalizedReads.some((r) => r === requiredResolved)) {
        missingPatterns.push(required);
      }
    } else {
      if (
        !readFilePaths.some((p) => {
          const normalizedRel = path
            .relative(workspaceDir, path.resolve(workspaceDir, p))
            .split(path.sep)
            .join("/");
          return required.test(normalizedRel);
        })
      ) {
        missingPatterns.push(required.source);
      }
    }
  }

  return { passed: missingPatterns.length === 0, missingPatterns };
}

/**
 * Read messages from a session JSONL file, starting from a specific byte offset.
 * Only reads content written AFTER the given offset (i.e., post-compaction activity).
 * If offset is undefined or 0, reads the last maxLines lines as a fallback.
 */
export function readSessionMessages(
  sessionFile: string,
  fromByteOffset?: number,
  maxLines = 100,
): Array<{ role: string; content: unknown }> {
  if (!fs.existsSync(sessionFile)) {
    return [];
  }
  try {
    let text: string;
    if (fromByteOffset !== undefined && fromByteOffset > 0) {
      // Read only bytes written after the compaction boundary
      const stat = fs.statSync(sessionFile);
      const readLength = stat.size - fromByteOffset;
      if (readLength <= 0) {
        return [];
      }
      const buf = Buffer.alloc(readLength);
      const fd = fs.openSync(sessionFile, "r");
      try {
        fs.readSync(fd, buf, 0, readLength, fromByteOffset);
      } finally {
        fs.closeSync(fd);
      }
      text = buf.toString("utf-8");
    } else {
      // Fallback: last N lines (no offset known)
      text = fs.readFileSync(sessionFile, "utf-8");
      const lines = text.trim().split("\n");
      text = lines.slice(-maxLines).join("\n");
    }

    const messages: Array<{ role: string; content: unknown }> = [];
    for (const line of text.split("\n")) {
      try {
        const entry = JSON.parse(line);
        if (entry.type === "message" && entry.message) {
          messages.push(entry.message);
        }
      } catch {
        // skip malformed lines
      }
    }
    return messages;
  } catch {
    return [];
  }
}

/**
 * Get the current byte size of a session file.
 * Used to record the compaction boundary before the next turn begins.
 */
export function getSessionFileOffset(sessionFile: string): number {
  try {
    return fs.statSync(sessionFile).size;
  } catch {
    return 0;
  }
}

/**
 * Extract file paths from Read tool calls in agent messages.
 * Handles multiple tool-call block shapes used across providers:
 *   - Anthropic canonical: { type: "tool_use", name, input: { file_path | path } }
 *   - Transcript-repaired: { type: "toolCall" | "toolUse", name, input | arguments }
 */
export function extractReadPaths(messages: Array<{ role: string; content: unknown }>): string[] {
  const paths: string[] = [];
  for (const msg of messages) {
    if (msg.role !== "assistant" || !Array.isArray(msg.content)) {
      continue;
    }
    for (const block of msg.content as Array<Record<string, unknown>>) {
      const type = block.type;
      const isToolCall =
        type === "tool_use" || type === "toolCall" || type === "toolUse" || type === "functionCall";
      if (!isToolCall) {
        continue;
      }
      const name = block.name ?? block.function;
      if (typeof name !== "string" || name.toLowerCase() !== "read") {
        continue;
      }
      // Support both `input` (Anthropic/canonical) and `arguments` (OpenAI/repaired)
      const args = (block.input ?? block.arguments) as Record<string, unknown> | undefined;
      const filePath = args?.file_path ?? args?.path;
      if (typeof filePath === "string") {
        paths.push(filePath);
      }
    }
  }
  return paths;
}

/** Format the audit warning message */
export function formatAuditWarning(missingPatterns: string[]): string {
  return (
    "⚠️ Post-Compaction Audit: The following required startup files were not read after context reset:\n" +
    missingPatterns.map((p) => `  - ${p}`).join("\n") +
    "\n\nPlease read them now using the Read tool before continuing. This ensures your operating protocols are restored after memory compaction."
  );
}
