/**
 * Compact tool error summary types.
 *
 * Stores failure metadata used by transcripts, retry behavior, and mutation recovery logic.
 */
import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import type { FileTarget } from "./tool-mutation.js";

export type ToolErrorSummary = {
  toolName: string;
  meta?: string;
  errorCode?: string;
  error?: string;
  timedOut?: boolean;
  middlewareError?: boolean;
  mutatingAction?: boolean;
  actionFingerprint?: string;
  fileTarget?: FileTarget;
};

const EXEC_LIKE_TOOL_NAMES = new Set(["exec", "bash"]);

/** Detects shell-execution tools that share retry and mutation semantics. */
export function isExecLikeToolName(toolName: string): boolean {
  return EXEC_LIKE_TOOL_NAMES.has(normalizeOptionalLowercaseString(toolName) ?? "");
}

const MAX_ABORT_SUMMARY_LENGTH = 160;

/**
 * One-line, argument-free summary of the last tool failure for the TUI abort line.
 * Cuts at the `Received arguments:` marker that validateToolArguments
 * (packages/llm-core/src/validation.ts) appends, so raw model args never reach the screen.
 */
export function summarizeToolErrorForAbort(summary: ToolErrorSummary): string | undefined {
  const raw = summary.error?.trim();
  if (!raw) {
    return undefined;
  }
  const argsMarker = raw.indexOf("Received arguments:");
  const body = (argsMarker >= 0 ? raw.slice(0, argsMarker) : raw).trim();
  const isValidation = body.startsWith("Validation failed for tool");
  const bulletDetails = body
    .split("\n")
    .map((line) => /^\s*-\s+(.+)$/.exec(line)?.[1])
    .filter((detail): detail is string => detail !== undefined);
  const detailSource =
    bulletDetails.length > 0
      ? bulletDetails.join("; ")
      : isValidation
        ? body.split("\n").slice(1).join(" ")
        : body;
  const detail = detailSource.replace(/\s+/g, " ").trim();
  if (!detail) {
    return undefined;
  }
  const verb = isValidation ? "validation failed" : "failed";
  const label = `${summary.toolName.trim() || "tool"} tool ${verb}: ${detail}`;
  return label.length > MAX_ABORT_SUMMARY_LENGTH
    ? `${label.slice(0, MAX_ABORT_SUMMARY_LENGTH - 1)}…`
    : label;
}
