import yaml from "yaml";
import { QueueFrontmatterSchema } from "./schemas.js";
import type { QueueFrontmatter, ParseResult } from "./types.js";

export interface QueueEntry {
  taskId: string;
  metadata: Record<string, string>;
}

export interface ParsedQueue {
  frontmatter: QueueFrontmatter | null;
  available: QueueEntry[];
  claimed: QueueEntry[];
  done: QueueEntry[];
  blocked: QueueEntry[];
}

/** Parse bracket metadata like `[key: value, key2: value2]` from a line fragment. */
function parseBracketMetadata(text: string): Record<string, string> {
  const metadata: Record<string, string> = {};
  const bracketPattern = /\[([^\]]+)\]/g;
  let match: RegExpExecArray | null;

  while ((match = bracketPattern.exec(text)) !== null) {
    const inner = match[1];
    // Split by comma, but only start a new key-value pair when the segment contains a colon.
    // Segments without a colon are appended to the previous value (e.g. "capabilities: code, testing").
    const segments = inner.split(",");
    let currentKey = "";
    let currentValue = "";

    for (const segment of segments) {
      const colonIdx = segment.indexOf(":");
      if (colonIdx !== -1 && /^\s*\w+\s*:/.test(segment)) {
        // Flush previous pair
        if (currentKey) {
          metadata[currentKey] = currentValue;
        }
        currentKey = segment.slice(0, colonIdx).trim();
        currentValue = segment.slice(colonIdx + 1).trim();
      } else if (currentKey) {
        // No colon -- continuation of previous value (e.g. "code, testing")
        currentValue += `, ${segment.trim()}`;
      }
    }
    // Flush last pair
    if (currentKey) {
      metadata[currentKey] = currentValue;
    }
  }

  return metadata;
}

/** Parse trailing `key: value` pairs outside brackets. */
function parseTrailingMetadata(text: string): Record<string, string> {
  // Remove bracket sections first
  const withoutBrackets = text.replace(/\[[^\]]*\]/g, "");
  const metadata: Record<string, string> = {};
  const trailingPattern = /(\w+):\s*(\S+)/g;
  let match: RegExpExecArray | null;

  while ((match = trailingPattern.exec(withoutBrackets)) !== null) {
    metadata[match[1]] = match[2];
  }

  return metadata;
}

/** Parse list items in a section into QueueEntry objects. */
function parseSectionEntries(sectionContent: string): QueueEntry[] {
  const entries: QueueEntry[] = [];
  const lines = sectionContent.split("\n");
  const taskPattern = /^\s*-\s+(TASK-\d+)\s*(.*)/;

  for (const line of lines) {
    const match = taskPattern.exec(line);
    if (!match) {
      continue;
    }

    const taskId = match[1];
    const rest = match[2];

    const bracketMeta = parseBracketMetadata(rest);
    const trailingMeta = parseTrailingMetadata(rest);

    entries.push({
      taskId,
      metadata: { ...bracketMeta, ...trailingMeta },
    });
  }

  return entries;
}

/** Split markdown body into heading-keyed sections (case-insensitive). */
function splitSections(body: string): Record<string, string> {
  const sections: Record<string, string> = {};
  // Split on ## headings, keeping the heading text
  const parts = body.split(/^##\s+(.+)$/im);

  // parts alternates: [pre-heading-text, heading1, content1, heading2, content2, ...]
  for (let i = 1; i < parts.length; i += 2) {
    const heading = parts[i].trim().toLowerCase();
    const content = parts[i + 1] ?? "";
    sections[heading] = content;
  }

  return sections;
}

/**
 * Parse queue frontmatter using yaml + Zod schema directly.
 * This avoids depending on frontmatter.ts which may not exist yet during parallel builds.
 */
function parseQueueFrontmatter(content: string, filePath: string): ParseResult<QueueFrontmatter> {
  const normalized = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (!normalized.startsWith("---")) {
    return {
      success: false,
      error: {
        filePath,
        message: "No frontmatter block found",
        issues: [{ path: "", message: "Missing opening ---" }],
      },
    };
  }

  const endIndex = normalized.indexOf("\n---", 3);
  if (endIndex === -1) {
    return {
      success: false,
      error: {
        filePath,
        message: "Unclosed frontmatter block",
        issues: [{ path: "", message: "Missing closing ---" }],
      },
    };
  }

  const yamlStr = normalized.slice(4, endIndex);
  try {
    const raw = yaml.parse(yamlStr) ?? {};
    const result = QueueFrontmatterSchema.safeParse(raw);
    if (result.success) {
      return { success: true, data: result.data };
    }
    return {
      success: false,
      error: {
        filePath,
        message: "Queue frontmatter validation failed",
        issues: result.error.issues.map((i) => ({
          path: i.path.join("."),
          message: i.message,
        })),
      },
    };
  } catch (err) {
    return {
      success: false,
      error: {
        filePath,
        message: "YAML parse error",
        issues: [{ path: "", message: err instanceof Error ? err.message : String(err) }],
      },
    };
  }
}

/**
 * Parse a queue.md file into structured sections with typed entries.
 *
 * Queue format:
 * - Optional YAML frontmatter (updated timestamp)
 * - Sections: ## Available, ## Claimed, ## Done, ## Blocked
 * - List items: `- TASK-003 [capabilities: code, testing] priority: high`
 */
export function parseQueue(content: string, filePath: string): ParsedQueue {
  // 1. Parse frontmatter
  const fmResult = parseQueueFrontmatter(content, filePath);
  const frontmatter = fmResult.success ? fmResult.data : null;

  // 2. Extract body (everything after frontmatter closing triple-dash)
  const normalized = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  let body = normalized;
  if (normalized.startsWith("---")) {
    const endIndex = normalized.indexOf("\n---", 3);
    if (endIndex !== -1) {
      body = normalized.slice(endIndex + 4);
    }
  }

  // 3. Split body into sections
  const sections = splitSections(body);

  // 4. Parse each section
  return {
    frontmatter,
    available: parseSectionEntries(sections["available"] ?? ""),
    claimed: parseSectionEntries(sections["claimed"] ?? ""),
    done: parseSectionEntries(sections["done"] ?? ""),
    blocked: parseSectionEntries(sections["blocked"] ?? ""),
  };
}
