import YAML from "yaml";
import type { z } from "zod";
import {
  ProjectFrontmatterSchema,
  QueueFrontmatterSchema,
  TaskFrontmatterSchema,
} from "./schemas.js";
import type {
  ParseResult,
  ProjectFrontmatter,
  QueueFrontmatter,
  TaskFrontmatter,
} from "./types.js";

/**
 * Extracts raw YAML content between opening and closing `---` fences.
 * Duplicated from src/markdown/frontmatter.ts to maintain independence (PARSE-04).
 */
function extractYamlBlock(content: string): string | undefined {
  const normalized = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (!normalized.startsWith("---")) {
    return undefined;
  }
  const endIndex = normalized.indexOf("\n---", 3);
  if (endIndex === -1) {
    return undefined;
  }
  return normalized.slice(4, endIndex);
}

/**
 * Parses YAML frontmatter and validates against a Zod schema.
 * Returns a discriminated union: success with typed data, or failure with structured error.
 */
function parseAndValidate<T>(
  content: string,
  filePath: string,
  schema: z.ZodType<T>,
): ParseResult<T> {
  const block = extractYamlBlock(content);
  if (block === undefined) {
    return {
      success: false,
      error: {
        filePath,
        message: "No frontmatter block found",
        issues: [],
      },
    };
  }

  let parsed: unknown;
  try {
    // Use "core" schema to avoid YAML 1.1 quirks (e.g. "no" as boolean)
    parsed = YAML.parse(block, { schema: "core" });
  } catch (err: unknown) {
    let line: number | undefined;
    let message = "Unknown YAML error";
    if (err instanceof Error) {
      message = err.message;
    }
    // yaml library errors expose linePos for syntax errors
    if (
      err != null &&
      typeof err === "object" &&
      "linePos" in err &&
      Array.isArray((err as Record<string, unknown>).linePos)
    ) {
      const linePos = (err as Record<string, unknown>).linePos as Array<{
        line: number;
      }>;
      if (linePos.length > 0) {
        line = linePos[0].line;
      }
    }
    return {
      success: false,
      error: {
        filePath,
        message: `YAML parse error: ${message}`,
        issues: [{ path: "", message, line }],
      },
    };
  }

  // Empty frontmatter block (e.g. "---\n---") parses as null
  const data = parsed ?? {};

  const result = schema.safeParse(data);
  if (!result.success) {
    const issues = result.error.issues.map((i) => ({
      path: i.path.join("."),
      message: i.message,
    }));
    return {
      success: false,
      error: {
        filePath,
        message: "Schema validation failed",
        issues,
      },
    };
  }

  return { success: true, data: result.data };
}

export function parseProjectFrontmatter(
  content: string,
  filePath: string,
): ParseResult<ProjectFrontmatter> {
  return parseAndValidate(content, filePath, ProjectFrontmatterSchema);
}

export function parseTaskFrontmatter(
  content: string,
  filePath: string,
): ParseResult<TaskFrontmatter> {
  return parseAndValidate(content, filePath, TaskFrontmatterSchema);
}

export function parseQueueFrontmatter(
  content: string,
  filePath: string,
): ParseResult<QueueFrontmatter> {
  return parseAndValidate(content, filePath, QueueFrontmatterSchema);
}
