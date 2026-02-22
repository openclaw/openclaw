/**
 * Structured Tool Reflection
 *
 * Implements the "Reflect, then Call" pattern for tool error recovery.
 * When a tool call fails, this module annotates the error result with
 * structured diagnostic context — classifying the failure type, suggesting
 * corrective actions, and tracking repeated failures to prevent loops.
 *
 * Inspired by: "Failure Makes the Agent Stronger: Enhancing Accuracy through
 * Structured Reflection for Reliable Tool Interactions" (arxiv:2509.18847)
 *
 * Key principles:
 * - Explicit error diagnosis beats "try again"
 * - Failure categories guide repair strategies
 * - Tracking repeated errors prevents infinite retry loops
 */

import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { TextContent } from "@mariozechner/pi-ai";

// ─── Error Classification ────────────────────────────────────────────

export type ToolErrorCategory =
  | "permission_denied"
  | "not_found"
  | "invalid_params"
  | "timeout"
  | "rate_limit"
  | "format_error"
  | "size_limit"
  | "connection_error"
  | "auth_error"
  | "conflict"
  | "unknown";

export type ToolReflection = {
  /** The classified error category */
  category: ToolErrorCategory;
  /** Human-readable diagnosis of what went wrong */
  diagnosis: string;
  /** Suggested corrective action(s) */
  suggestions: string[];
  /** Whether this is a repeated failure (same tool + similar error) */
  isRepeated: boolean;
  /** How many times this pattern has been seen in the current session */
  repeatCount: number;
};

// ─── Error Classification Patterns ───────────────────────────────────

type ClassificationRule = {
  category: ToolErrorCategory;
  patterns: RegExp[];
};

const CLASSIFICATION_RULES: ClassificationRule[] = [
  {
    category: "permission_denied",
    patterns: [
      /permission denied/i,
      /access denied/i,
      /EACCES/,
      /EPERM/,
      /forbidden/i,
      /not allowed/i,
      /insufficient permissions/i,
      /operation not permitted/i,
    ],
  },
  {
    category: "not_found",
    patterns: [
      /no such file/i,
      /not found/i,
      /ENOENT/,
      /does not exist/i,
      /couldn't find/i,
      /cannot find/i,
      /path .+ doesn't exist/i,
      /file .+ missing/i,
      /no matches found/i,
      /command not found/i,
    ],
  },
  {
    category: "invalid_params",
    patterns: [
      /invalid param/i,
      /missing required/i,
      /expected .+ but got/i,
      /type error/i,
      /validation (failed|error)/i,
      /invalid (argument|option|value)/i,
      /unknown (option|flag|param)/i,
      /unrecognized/i,
      /must be .+ (a|an) /i,
      /cannot parse/i,
    ],
  },
  {
    category: "timeout",
    patterns: [
      /timeout/i,
      /timed out/i,
      /ETIMEDOUT/,
      /ESOCKETTIMEDOUT/,
      /deadline exceeded/i,
      /took too long/i,
    ],
  },
  {
    category: "rate_limit",
    patterns: [/rate limit/i, /too many requests/i, /429/, /throttl/i, /quota exceeded/i],
  },
  {
    category: "format_error",
    patterns: [
      /syntax error/i,
      /parse error/i,
      /unexpected token/i,
      /malformed/i,
      /invalid (json|xml|yaml|format)/i,
      /unterminated/i,
    ],
  },
  {
    category: "size_limit",
    patterns: [
      /too (large|big|long)/i,
      /size limit/i,
      /exceeded .+ limit/i,
      /payload too/i,
      /content.+truncated/i,
      /EFBIG/,
    ],
  },
  {
    category: "connection_error",
    patterns: [
      /ECONNREFUSED/,
      /ECONNRESET/,
      /ENOTFOUND/,
      /network error/i,
      /connection refused/i,
      /connection reset/i,
      /unable to connect/i,
      /DNS/i,
    ],
  },
  {
    category: "auth_error",
    patterns: [
      /unauthorized/i,
      /unauthenticated/i,
      /invalid (token|key|credential)/i,
      /auth.+fail/i,
      /401/,
      /expired token/i,
    ],
  },
  {
    category: "conflict",
    patterns: [/conflict/i, /already exists/i, /duplicate/i, /EEXIST/, /in use/i],
  },
];

/**
 * Classify a tool error message into a structured category.
 */
export function classifyToolError(errorText: string): ToolErrorCategory {
  if (!errorText) {
    return "unknown";
  }

  for (const rule of CLASSIFICATION_RULES) {
    for (const pattern of rule.patterns) {
      if (pattern.test(errorText)) {
        return rule.category;
      }
    }
  }

  return "unknown";
}

// ─── Diagnostic Suggestions ──────────────────────────────────────────

const CATEGORY_SUGGESTIONS: Record<ToolErrorCategory, string[]> = {
  permission_denied: [
    "Check file/directory permissions and ownership",
    "Try a different path that is within the allowed scope",
    "If writing, ensure the target directory is writable",
  ],
  not_found: [
    "Verify the path or resource name — check for typos",
    "Use 'read' or 'exec(ls)' to list available files in the directory",
    "The resource may have been moved or renamed — search for it",
  ],
  invalid_params: [
    "Review the tool's parameter schema carefully",
    "Check parameter types — string vs number vs boolean",
    "Ensure all required parameters are provided",
    "Remove unrecognized optional parameters",
  ],
  timeout: [
    "The operation took too long — try a smaller scope or add pagination",
    "For exec commands: use a timeout parameter or break into smaller steps",
    "Check if the target service is responsive first",
  ],
  rate_limit: [
    "Wait briefly before retrying (exponential backoff)",
    "Reduce the frequency of requests",
    "Consider batching multiple small requests into one larger one",
  ],
  format_error: [
    "Check the syntax of the input — look for unclosed quotes or brackets",
    "Validate JSON/YAML structure before passing it",
    "Escape special characters properly",
  ],
  size_limit: [
    "Reduce the input size — use offset/limit for large reads",
    "Break the operation into smaller chunks",
    "Summarize or filter the data before processing",
  ],
  connection_error: [
    "The target service may be down — check status or try again shortly",
    "Verify the URL or hostname is correct",
    "Check if network connectivity is available",
  ],
  auth_error: [
    "Credentials may be expired or invalid — check authentication setup",
    "Verify the API key or token is correct",
    "Check if the auth profile needs to be refreshed",
  ],
  conflict: [
    "The resource already exists — use a different name or update the existing one",
    "Check for concurrent operations that may be conflicting",
    "If editing, ensure the file content matches what you expect (re-read first)",
  ],
  unknown: [
    "Read the full error message carefully for specific guidance",
    "Try a different approach to achieve the same goal",
    "Break the operation into smaller, diagnostic steps to isolate the issue",
  ],
};

function buildDiagnosis(category: ToolErrorCategory, toolName: string, _errorText: string): string {
  const categoryLabels: Record<ToolErrorCategory, string> = {
    permission_denied: "Permission/Access Denied",
    not_found: "Resource Not Found",
    invalid_params: "Invalid Parameters",
    timeout: "Operation Timeout",
    rate_limit: "Rate Limit Exceeded",
    format_error: "Format/Syntax Error",
    size_limit: "Size Limit Exceeded",
    connection_error: "Connection Error",
    auth_error: "Authentication Error",
    conflict: "Resource Conflict",
    unknown: "Unclassified Error",
  };

  return `Tool '${toolName}' failed — ${categoryLabels[category]}.`;
}

// ─── Session Failure Tracker ─────────────────────────────────────────

type FailureRecord = {
  toolName: string;
  category: ToolErrorCategory;
  /** Fingerprint: toolName + category */
  fingerprint: string;
  timestamp: number;
};

/**
 * Lightweight in-memory tracker for tool failures within a session.
 * Tracks failure patterns to detect repeated errors and prevent infinite loops.
 *
 * The tracker is designed to be short-lived (per-session) and does not persist.
 */
export class ToolFailureTracker {
  private failures: FailureRecord[] = [];
  private readonly maxRecords: number;
  private readonly windowMs: number;

  /**
   * @param maxRecords Maximum failure records to retain (default: 50)
   * @param windowMs Time window for repeat detection in ms (default: 5 minutes)
   */
  constructor(maxRecords = 50, windowMs = 5 * 60 * 1000) {
    this.maxRecords = maxRecords;
    this.windowMs = windowMs;
  }

  /**
   * Record a tool failure and return how many times this pattern
   * has occurred within the time window.
   */
  record(toolName: string, category: ToolErrorCategory): number {
    const now = Date.now();
    const fingerprint = `${toolName}:${category}`;

    this.failures.push({ toolName, category, fingerprint, timestamp: now });

    // Evict old records
    if (this.failures.length > this.maxRecords) {
      this.failures = this.failures.slice(-this.maxRecords);
    }

    // Count matching failures within the window
    const cutoff = now - this.windowMs;
    return this.failures.filter((f) => f.fingerprint === fingerprint && f.timestamp >= cutoff)
      .length;
  }

  /**
   * Get the count of a specific failure pattern within the time window.
   */
  getCount(toolName: string, category: ToolErrorCategory): number {
    const fingerprint = `${toolName}:${category}`;
    const cutoff = Date.now() - this.windowMs;
    return this.failures.filter((f) => f.fingerprint === fingerprint && f.timestamp >= cutoff)
      .length;
  }

  /**
   * Clear all records. Useful for testing or session reset.
   */
  clear(): void {
    this.failures = [];
  }

  /**
   * Get the total number of tracked failures.
   */
  get size(): number {
    return this.failures.length;
  }
}

// ─── Reflection Builder ──────────────────────────────────────────────

/**
 * Build a structured reflection for a tool error.
 */
export function buildToolReflection(
  toolName: string,
  errorText: string,
  tracker?: ToolFailureTracker,
): ToolReflection {
  const category = classifyToolError(errorText);
  const diagnosis = buildDiagnosis(category, toolName, errorText);
  const suggestions = [...CATEGORY_SUGGESTIONS[category]];

  let repeatCount = 1;
  let isRepeated = false;

  if (tracker) {
    repeatCount = tracker.record(toolName, category);
    isRepeated = repeatCount > 1;
  }

  // Add escalation suggestions for repeated failures
  if (isRepeated && repeatCount >= 3) {
    suggestions.unshift(
      `⚠️ This is attempt #${repeatCount} with the same error pattern. ` +
        `STOP and try a fundamentally different approach.`,
    );
  } else if (isRepeated) {
    suggestions.unshift(
      `This error has occurred ${repeatCount} times. ` +
        `Consider a different strategy rather than repeating the same approach.`,
    );
  }

  return {
    category,
    diagnosis,
    suggestions,
    isRepeated,
    repeatCount,
  };
}

// ─── Tool Result Annotation ──────────────────────────────────────────

const REFLECTION_MARKER = "\n\n───── Structured Reflection ─────\n";

/**
 * Format a ToolReflection into a text annotation that will be appended
 * to the tool result error message.
 */
export function formatReflectionAnnotation(reflection: ToolReflection): string {
  const lines: string[] = [
    REFLECTION_MARKER,
    `📋 Error Category: ${reflection.category}`,
    `🔍 Diagnosis: ${reflection.diagnosis}`,
  ];

  if (reflection.isRepeated) {
    lines.push(`⚠️ Repeat: #${reflection.repeatCount} occurrence of this error pattern`);
  }

  lines.push("💡 Suggested Actions:");
  for (const suggestion of reflection.suggestions) {
    lines.push(`  • ${suggestion}`);
  }

  lines.push("─────────────────────────────────");
  return lines.join("\n");
}

/**
 * Check if a tool result message contains an error.
 *
 * Tool results can carry errors in several ways:
 * - An `isError` flag on the message
 * - Text content containing error indicators (stack traces, "Error:", etc.)
 * - An explicit `error` field
 */
export function isToolResultError(msg: AgentMessage): boolean {
  if (!msg || typeof msg !== "object") {
    return false;
  }

  const record = msg as unknown as Record<string, unknown>;

  // Explicit error flag
  if (record.isError === true) {
    return true;
  }

  // Check role
  if (record.role !== "toolResult") {
    return false;
  }

  // Check for error text patterns in content
  const content = record.content;
  if (!Array.isArray(content)) {
    return false;
  }

  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    if ((block as TextContent).type !== "text") {
      continue;
    }
    const text = (block as TextContent).text;
    if (typeof text !== "string") {
      continue;
    }
    // Check for common error indicators
    if (
      /^(Error|error):/m.test(text) ||
      /Command (exited|failed) with (code|status) [1-9]/i.test(text) ||
      /^\s*(Traceback|FATAL|PANIC)/m.test(text)
    ) {
      return true;
    }
  }

  return false;
}

/**
 * Extract the error text from a tool result message.
 * Returns null if no error text can be extracted.
 */
export function extractErrorText(msg: AgentMessage): string | null {
  if (!msg || typeof msg !== "object") {
    return null;
  }

  const record = msg as unknown as Record<string, unknown>;
  const content = record.content;
  if (!Array.isArray(content)) {
    return null;
  }

  const textParts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    if ((block as TextContent).type !== "text") {
      continue;
    }
    const text = (block as TextContent).text;
    if (typeof text === "string") {
      textParts.push(text);
    }
  }

  return textParts.length > 0 ? textParts.join("\n") : null;
}

/**
 * Check if a tool result message already has a reflection annotation.
 */
export function hasReflectionAnnotation(msg: AgentMessage): boolean {
  const text = extractErrorText(msg);
  return text !== null && text.includes(REFLECTION_MARKER.trim());
}

/**
 * Annotate a tool result error message with structured reflection.
 *
 * Returns the original message unchanged if:
 * - The message is not a tool result
 * - The message does not contain an error
 * - The message already has a reflection annotation
 *
 * @param msg The tool result message
 * @param toolName The name of the tool that was called
 * @param tracker Optional failure tracker for repeat detection
 * @returns The annotated message (or original if no annotation needed)
 */
export function annotateToolResultWithReflection(
  msg: AgentMessage,
  toolName: string,
  tracker?: ToolFailureTracker,
): AgentMessage {
  // Only annotate tool results
  if (
    !msg ||
    typeof msg !== "object" ||
    (msg as unknown as Record<string, unknown>).role !== "toolResult"
  ) {
    return msg;
  }

  // Only annotate errors
  if (!isToolResultError(msg)) {
    return msg;
  }

  // Don't double-annotate
  if (hasReflectionAnnotation(msg)) {
    return msg;
  }

  const errorText = extractErrorText(msg);
  if (!errorText) {
    return msg;
  }

  const reflection = buildToolReflection(toolName, errorText, tracker);
  const annotation = formatReflectionAnnotation(reflection);

  // Append the annotation to the last text block in the content
  const content = (msg as unknown as Record<string, unknown>).content;
  if (!Array.isArray(content)) {
    return msg;
  }

  // Find the last text block to append to
  let lastTextIndex = -1;
  for (let i = content.length - 1; i >= 0; i--) {
    const block = content[i];
    if (block && typeof block === "object" && (block as TextContent).type === "text") {
      lastTextIndex = i;
      break;
    }
  }

  if (lastTextIndex === -1) {
    return msg;
  }

  const newContent = content.map((block: unknown, index: number) => {
    if (index !== lastTextIndex) {
      return block;
    }
    const textBlock = block as TextContent;
    return {
      ...textBlock,
      text: textBlock.text + annotation,
    };
  });

  return { ...msg, content: newContent } as AgentMessage;
}
