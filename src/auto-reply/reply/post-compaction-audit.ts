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
  return configured.map((entry) => {
    if (entry.startsWith("/") && entry.endsWith("/")) {
      // Treat slash-wrapped strings as regex: "/memory\/\d+\.md/"
      return new RegExp(entry.slice(1, -1));
    }
    return entry;
  });
}

/**
 * Check whether post-compaction audit is enabled.
 * Defaults to true if not explicitly configured.
 */
export function isPostCompactionAuditEnabled(cfg?: OpenClawConfig): boolean {
  return cfg?.hooks?.postCompactionAudit?.enabled !== false;
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
 * Read messages from a session JSONL file.
 * Returns messages from the last N lines (default 100).
 */
export function readSessionMessages(
  sessionFile: string,
  maxLines = 100,
): Array<{ role: string; content: unknown }> {
  if (!fs.existsSync(sessionFile)) {
    return [];
  }
  try {
    const recentLines = fs.readFileSync(sessionFile, "utf-8").trim().split("\n").slice(-maxLines);
    const messages: Array<{ role: string; content: unknown }> = [];
    for (const line of recentLines) {
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
 * Extract file paths from Read tool calls in agent messages.
 * Looks for tool_use blocks with name="read" and extracts path/file_path args.
 */
export function extractReadPaths(messages: Array<{ role: string; content: unknown }>): string[] {
  const paths: string[] = [];
  for (const msg of messages) {
    if (msg.role !== "assistant" || !Array.isArray(msg.content)) {
      continue;
    }
    for (const block of msg.content as Array<{
      type: string;
      name?: string;
      input?: Record<string, unknown>;
    }>) {
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
  return (
    "⚠️ Post-Compaction Audit: The following required startup files were not read after context reset:\n" +
    missingPatterns.map((p) => `  - ${p}`).join("\n") +
    "\n\nPlease read them now using the Read tool before continuing. This ensures your operating protocols are restored after memory compaction."
  );
}
