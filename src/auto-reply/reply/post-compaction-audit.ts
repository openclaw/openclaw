import fs from "node:fs";
import path from "node:path";

// Default required files — constants, extensible to config later
// memory pattern: matches both memory/YYYY-MM-DD.md and memory/timeline/YYYY-MM-DD.md (RippleJay)
const DEFAULT_REQUIRED_READS: Array<string | RegExp> = [
  "WORKFLOW_AUTO.md",
  /memory\/(?:timeline\/)?\d{4}-\d{2}-\d{2}\.md/, // daily memory (standard + RippleJay)
];

const CONFIG_PATHS = ["audit/post_compaction_required.json", "audit/startup_files.json"];

type WorkspaceConfig = {
  required?: string[];
  patterns?: string[];
  items?: Array<{ path: string; level?: string }>;
};

function loadRequiredReadsFromWorkspace(workspaceDir: string): Array<string | RegExp> | null {
  for (const relPath of CONFIG_PATHS) {
    const configPath = path.join(workspaceDir, relPath);
    try {
      if (!fs.existsSync(configPath)) {
        continue;
      }
      const raw = fs.readFileSync(configPath, "utf-8");
      const cfg = JSON.parse(raw) as WorkspaceConfig;
      const result: Array<string | RegExp> = [];
      if (Array.isArray(cfg.required)) {
        result.push(...cfg.required);
      }
      if (Array.isArray(cfg.items)) {
        for (const item of cfg.items) {
          if (item.level === "P0" && typeof item.path === "string") {
            result.push(item.path);
          }
        }
      }
      if (Array.isArray(cfg.patterns)) {
        for (const p of cfg.patterns) {
          if (typeof p === "string") {
            try {
              result.push(new RegExp(p));
            } catch {
              // skip invalid regex
            }
          } else if (
            p &&
            typeof p === "object" &&
            "regex" in p &&
            typeof (p as { regex: string }).regex === "string"
          ) {
            const regex = (p as { regex: string; level?: string }).regex;
            if ((p as { level?: string }).level === "P0" || !("level" in p)) {
              try {
                result.push(new RegExp(regex));
              } catch {
                // skip invalid regex
              }
            }
          }
        }
      }
      if (result.length > 0) {
        return result;
      }
    } catch {
      // silent fallback to default
    }
  }
  return null;
}

/**
 * Audit whether agent read required startup files after compaction.
 * Returns list of missing file patterns.
 * Loads config from workspace/audit/post_compaction_required.json if present.
 */
export function auditPostCompactionReads(
  readFilePaths: string[],
  workspaceDir: string,
  requiredReads?: Array<string | RegExp>,
): { passed: boolean; missingPatterns: string[] } {
  const resolved =
    requiredReads ?? loadRequiredReadsFromWorkspace(workspaceDir) ?? DEFAULT_REQUIRED_READS;
  const normalizedReads = readFilePaths.map((p) => path.resolve(workspaceDir, p));
  const missingPatterns: string[] = [];

  // if today’s timeline hasn't been created yet, skip the daily-file regex

  const shouldSkipTimelineCheck = (() => {
    const DATE_REGEX = /memory\/(?:timeline\/)?\d{4}-\d{2}-\d{2}\.md/;
    const today = new Date().toISOString().slice(0, 10);
    const candidates = [
      path.join(workspaceDir, "memory", `${today}.md`),
      path.join(workspaceDir, "memory", "timeline", `${today}.md`),
    ];
    const todayExists = candidates.some((p) => fs.existsSync(p));
    return !todayExists && resolved.some((r) => typeof r !== "string" && DATE_REGEX.test(r.source));
  })();

  for (const required of resolved) {
    if (typeof required === "string") {
      const requiredResolved = path.resolve(workspaceDir, required);
      const found = normalizedReads.some((r) => r === requiredResolved);
      if (!found) {
        if (
          shouldSkipTimelineCheck &&
          typeof required !== "string" &&
          /\d{4}-\d{2}-\d{2}/.test(required.source)
        ) {
          // skip timeline requirement when the file doesn't exist yet
        } else {
          missingPatterns.push(required);
        }
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
        if (!(shouldSkipTimelineCheck && /\d{4}-\d{2}-\d{2}/.test(required.source))) {
          missingPatterns.push(required.source);
        }
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
