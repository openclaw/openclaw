/**
 * Unified tool execution with consistent error handling.
 * Used by both Pi and Claude SDK runtime adapters.
 *
 * This module provides a single source of truth for:
 * - Error message truncation for console logs
 * - Structured error logging via logToolError()
 * - Debug detail logging
 * - Tool-specific context in error logs (exec, web_fetch, web_search)
 * - AbortError handling
 * - Performance measurement
 */

import type { AgentToolResult, AgentToolUpdateCallback } from "@mariozechner/pi-agent-core";
import type { AnyAgentTool } from "./common.js";
import { logDebug, logError } from "../../logger.js";
import { logToolError, measureOperation } from "../../logging/enhanced-events.js";
import { redactSensitiveText } from "../../logging/redact.js";
import { truncateForLog } from "../../logging/truncate.js";
import { jsonResult } from "./common.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ToolExecutionContext = {
  toolCallId: string;
  toolName: string;
  normalizedToolName: string;
  params: unknown;
  signal?: AbortSignal;
  onUpdate?: AgentToolUpdateCallback<unknown>;
  /** Session key for logging context */
  sessionKey?: string;
  /** Agent ID for logging context */
  agentId?: string;
};

export type ToolExecutionResult = {
  result: AgentToolResult<unknown>;
  durationMs: number;
  /** True if the tool was aborted */
  aborted?: boolean;
  /** Error details when execution failed (for caller to format as needed) */
  error?: {
    message: string;
    stack?: string;
  };
};

// ---------------------------------------------------------------------------
// Utility functions
// ---------------------------------------------------------------------------

/**
 * Extract the first line from a text string for console logging.
 * Truncates at the first line feed (\n or \r) to prevent multi-line subprocess
 * output from polluting console logs.
 *
 * For exec failures, prioritizes exit code information that typically appears
 * at the end of the full output, extracting it and prepending it to the first
 * line of actual output.
 *
 * @param text - The text to extract the first line from
 * @param maxLength - Maximum length of the returned string (default: 240)
 * @returns The first line, truncated to maxLength if needed
 */
export function extractFirstLine(text: string, maxLength: number = 240): string {
  // Check for exit code information at the end of the text
  // Pattern: "Command exited with code N" or "Command aborted by signal NAME"
  const exitCodeMatch = text.match(
    /(?:Command exited with code \d+|Command aborted by signal \w+|Command aborted before exit code was captured)$/,
  );
  const exitCodeInfo = exitCodeMatch ? exitCodeMatch[0] : null;

  // Find the first line feed (either \n or \r)
  const lfIndex = text.indexOf("\n");
  const crIndex = text.indexOf("\r");
  const firstLineEnd =
    lfIndex === -1 ? crIndex : crIndex === -1 ? lfIndex : Math.min(lfIndex, crIndex);

  if (firstLineEnd === -1) {
    // No line breaks found, just truncate if needed
    return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
  }

  // Extract the first line of actual output
  const firstLine = text.slice(0, firstLineEnd);

  // If we found exit code info at the end, prepend it to the first line
  if (exitCodeInfo) {
    const combined = `${exitCodeInfo} :: ${firstLine}`;
    return combined.length > maxLength ? `${combined.slice(0, maxLength)}…` : combined;
  }

  return firstLine.length > maxLength ? `${firstLine.slice(0, maxLength)}…` : firstLine;
}

/**
 * Extract HTTP status code from an error message.
 * Looks for patterns like "(404)" or "status=500" or "status: 403".
 *
 * @param text - The error message text
 * @returns The HTTP status code if found, undefined otherwise
 */
export function extractHttpStatusCode(text: string): number | undefined {
  // Check for status code in parentheses: "(404)"
  const parenMatch = text.match(/\((\d{3})\)/);
  if (parenMatch) {
    return Number(parenMatch[1]);
  }
  // Check for "status=404" or "status: 404" or "status 404"
  // Allow optional whitespace after colon/equals
  const statusMatch = text.match(/\bstatus(?:=|:)\s*(\d{3})\b/i);
  if (statusMatch) {
    return Number(statusMatch[1]);
  }
  // Check for "status 404" (space only, no colon/equals)
  const spaceMatch = text.match(/\bstatus\s+(\d{3})\b/i);
  if (spaceMatch) {
    return Number(spaceMatch[1]);
  }
  return undefined;
}

/**
 * Describe an error for logging purposes.
 * Returns the error message and optional stack trace.
 */
export function describeError(err: unknown): {
  message: string;
  stack?: string;
} {
  if (err instanceof Error) {
    const message = err.message?.trim() ? err.message : String(err);
    return { message, stack: err.stack };
  }
  return { message: String(err) };
}

/**
 * Build context parts for error logging.
 * Includes toolCallId, sessionId, and tool-specific context:
 * - exec: command and working directory
 * - web_fetch: URL (only for non-200/301 status codes to reduce noise)
 * - web_search: search query (truncated to 240 chars)
 *
 * @param ctx - Tool execution context
 * @param params - Tool parameters
 * @param errorMessage - Optional error message for extracting HTTP status codes
 */
export function buildErrorContextParts(
  ctx: ToolExecutionContext,
  params: unknown,
  errorMessage?: string,
): string[] {
  const contextParts: string[] = [`toolCallId=${ctx.toolCallId}`];

  if (ctx.sessionKey) {
    contextParts.push(`sessionId=${ctx.sessionKey}`);
  }

  // Extract tool-specific context
  if (params && typeof params === "object") {
    const p = params as Record<string, unknown>;

    // Exec command context
    if (ctx.normalizedToolName === "exec") {
      const execCommand = typeof p.command === "string" ? p.command : undefined;
      const execWorkdir = typeof p.workdir === "string" ? p.workdir : undefined;

      if (execCommand) {
        const redacted = redactSensitiveText(execCommand).trim();
        const preview = redacted.length > 240 ? `${redacted.slice(0, 240)}…` : redacted;
        contextParts.push(`cmd=${JSON.stringify(preview)}`);
      }
      if (execWorkdir) {
        contextParts.push(`cwd=${JSON.stringify(execWorkdir)}`);
      }
    }

    // Web fetch URL context (only log for non-success status codes)
    if (ctx.normalizedToolName === "web_fetch") {
      const url = typeof p.url === "string" ? p.url : undefined;
      if (url && errorMessage) {
        const httpStatus = extractHttpStatusCode(errorMessage);
        // Only include URL for non-success status codes to reduce log noise
        if (httpStatus !== undefined && httpStatus !== 200 && httpStatus !== 301) {
          const redacted = redactSensitiveText(url).trim();
          contextParts.push(`url=${JSON.stringify(redacted)}`);
        }
      }
    }

    // Web search query context
    if (ctx.normalizedToolName === "web_search") {
      const query = typeof p.query === "string" ? p.query : undefined;
      if (query) {
        const redacted = redactSensitiveText(query).trim();
        const preview = redacted.length > 240 ? `${redacted.slice(0, 240)}…` : redacted;
        contextParts.push(`query=${JSON.stringify(preview)}`);
      }
    }
  }

  return contextParts;
}

/**
 * Check if an error is an AbortError.
 */
function isAbortError(err: unknown): boolean {
  if (err instanceof Error && err.name === "AbortError") {
    return true;
  }
  if (err && typeof err === "object" && "name" in err) {
    return String((err as { name?: unknown }).name) === "AbortError";
  }
  return false;
}

// ---------------------------------------------------------------------------
// Main execution function
// ---------------------------------------------------------------------------

/**
 * Execute a tool with unified error handling.
 *
 * Features:
 * - Performance measurement via measureOperation()
 * - Consistent AbortError handling
 * - Error message truncation for console logs
 * - Enhanced structured logging via logToolError()
 * - Debug detail logging for _debugDetail errors
 * - Tool-specific context in error logs:
 *   - exec: command and working directory
 *   - web_fetch: URL (only for non-200/301 status codes)
 *   - web_search: search query (truncated)
 *
 * @param tool - The tool to execute
 * @param ctx - Execution context including params, signal, callbacks
 * @returns Execution result with the tool result, duration, and abort status
 */
export async function executeToolWithErrorHandling(
  tool: AnyAgentTool,
  ctx: ToolExecutionContext,
): Promise<ToolExecutionResult> {
  const startTime = Date.now();

  try {
    // Wrap with performance measurement
    const result = await measureOperation(
      "tool",
      ctx.normalizedToolName,
      () => tool.execute(ctx.toolCallId, ctx.params, ctx.signal, ctx.onUpdate),
      { toolCallId: ctx.toolCallId, sessionKey: ctx.sessionKey },
    );

    return {
      result,
      durationMs: Date.now() - startTime,
    };
  } catch (err) {
    const durationMs = Date.now() - startTime;

    // Check for abort - either via signal or AbortError
    if (ctx.signal?.aborted || isAbortError(err)) {
      return {
        result: jsonResult({
          status: "error",
          tool: ctx.normalizedToolName,
          error: "Tool execution was aborted",
        }),
        durationMs,
        aborted: true,
      };
    }

    // Describe the error
    const described = describeError(err);

    // Log stack trace at debug level if available and different from message
    if (described.stack && described.stack !== described.message) {
      logDebug(`[tools] ${ctx.normalizedToolName} stack:\n${described.stack}`);
    }

    // Build context parts for the error log (pass error message for HTTP status extraction)
    const contextParts = buildErrorContextParts(ctx, ctx.params, described.message);

    // Truncate message at first line for console logging
    const messageForLog = extractFirstLine(described.message, 240);
    logError(
      `[tools] ${ctx.normalizedToolName} failed: ${messageForLog} (${contextParts.join(" ")})`,
    );

    // Log debug details if available (e.g., wrapped error content from web_fetch)
    const debugDetail =
      err instanceof Error ? (err as unknown as Record<string, unknown>)._debugDetail : undefined;
    if (typeof debugDetail === "string") {
      logDebug(`[tools] ${ctx.normalizedToolName} debug detail:\n${truncateForLog(debugDetail)}`);
    }

    // Log enhanced error context via structured logging
    logToolError({
      toolName: ctx.normalizedToolName,
      input: ctx.params,
      error: err,
      sessionContext: {
        agentId: ctx.agentId,
        sessionId: ctx.sessionKey,
      },
      durationMs,
    });

    return {
      result: jsonResult({
        status: "error",
        tool: ctx.normalizedToolName,
        error: described.message,
      }),
      durationMs,
      error: described,
    };
  }
}
