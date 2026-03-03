import { escapeRegExp } from "../utils.js";

export const HEARTBEAT_TOKEN = "HEARTBEAT_OK";
export const SILENT_REPLY_TOKEN = "NO_REPLY";
export const CONTINUE_WORK_TOKEN = "CONTINUE_WORK";

const silentExactRegexByToken = new Map<string, RegExp>();
const silentTrailingRegexByToken = new Map<string, RegExp>();

function getSilentExactRegex(token: string): RegExp {
  const cached = silentExactRegexByToken.get(token);
  if (cached) {
    return cached;
  }
  const escaped = escapeRegExp(token);
  const regex = new RegExp(`^\\s*${escaped}\\s*$`);
  silentExactRegexByToken.set(token, regex);
  return regex;
}

function getSilentTrailingRegex(token: string): RegExp {
  const cached = silentTrailingRegexByToken.get(token);
  if (cached) {
    return cached;
  }
  const escaped = escapeRegExp(token);
  const regex = new RegExp(`(?:^|\\s+|\\*+)${escaped}\\s*$`);
  silentTrailingRegexByToken.set(token, regex);
  return regex;
}

export function isSilentReplyText(
  text: string | undefined,
  token: string = SILENT_REPLY_TOKEN,
): boolean {
  if (!text) {
    return false;
  }
  // Match only the exact silent token with optional surrounding whitespace.
  // This prevents substantive replies ending with NO_REPLY from being suppressed (#19537).
  return getSilentExactRegex(token).test(text);
}

/**
 * Strip a trailing silent reply token from mixed-content text.
 * Returns the remaining text with the token removed (trimmed).
 * If the result is empty, the entire message should be treated as silent.
 */
export function stripSilentToken(text: string, token: string = SILENT_REPLY_TOKEN): string {
  return text.replace(getSilentTrailingRegex(token), "").trim();
}

export function isSilentReplyPrefixText(
  text: string | undefined,
  token: string = SILENT_REPLY_TOKEN,
): boolean {
  if (!text) {
    return false;
  }
  const trimmed = text.trimStart();
  if (!trimmed) {
    return false;
  }
  // Guard against suppressing natural-language "No..." text while still
  // catching uppercase lead fragments like "NO" from streamed NO_REPLY.
  if (trimmed !== trimmed.toUpperCase()) {
    return false;
  }
  const normalized = trimmed.toUpperCase();
  if (!normalized) {
    return false;
  }
  if (normalized.length < 2) {
    return false;
  }
  if (/[^A-Z_]/.test(normalized)) {
    return false;
  }
  const tokenUpper = token.toUpperCase();
  if (!tokenUpper.startsWith(normalized)) {
    return false;
  }
  if (normalized.includes("_")) {
    return true;
  }
  // Keep underscore guard for generic tokens to avoid suppressing unrelated
  // uppercase words (e.g. HEART/HE with HEARTBEAT_OK). Only allow bare "NO"
  // because NO_REPLY streaming can transiently emit that fragment.
  return tokenUpper === SILENT_REPLY_TOKEN && normalized === "NO";
}

// ============================================================================
// Continuation signal parsing
// ============================================================================

export type ContinuationSignal =
  | { kind: "work"; delayMs?: number }
  | { kind: "delegate"; task: string; context?: string };

/**
 * Checks if the agent response ends with a continuation signal.
 * Returns the parsed signal or null if no continuation is requested.
 *
 * Formats:
 *   CONTINUE_WORK          → continue with default delay
 *   CONTINUE_WORK:30       → continue after 30 seconds
 *   CONTINUE_DELEGATE:task → spawn sub-agent with task
 */
export function parseContinuationSignal(text: string | undefined): ContinuationSignal | null {
  if (!text) {
    return null;
  }

  const trimmed = text.trim();

  // Check for CONTINUE_DELEGATE:<task> at end of response, on its own line.
  // Must be preceded by newline or start-of-string to avoid matching mid-sentence.
  // The task is single-line (no `s` flag) — multiline content goes in the optional
  // ---CONTEXT--- block. This prevents a mid-response instructional line like
  // "CONTINUE_DELEGATE:example\nMore text" from being misread as a real signal.
  const delegateWithContext = trimmed.match(
    /(?:^|\n)CONTINUE_DELEGATE:([^\n]+)\n---CONTEXT---(?:\n([\s\S]*))?$/,
  );
  if (delegateWithContext) {
    const task = delegateWithContext[1].trim();
    const contextText = (delegateWithContext[2] ?? "").trim();
    if (task) {
      return {
        kind: "delegate",
        task,
        context: contextText || undefined,
      };
    }
  }
  // No context block — single-line task at end of string
  const delegateSimple = trimmed.match(/(?:^|\n)CONTINUE_DELEGATE:([^\n]+)$/);
  if (delegateSimple) {
    const task = delegateSimple[1].trim();
    if (task) {
      return { kind: "delegate", task };
    }
  }

  // Check for CONTINUE_WORK or CONTINUE_WORK:<delay> at end of response
  const workMatch = trimmed.match(/\bCONTINUE_WORK(?::(\d+))?\s*$/);
  if (workMatch) {
    const delaySec = workMatch[1] ? parseInt(workMatch[1], 10) : undefined;
    return {
      kind: "work",
      delayMs: delaySec !== undefined ? delaySec * 1000 : undefined,
    };
  }

  return null;
}

/**
 * Strips the continuation signal from the response text, returning the
 * displayable text and the parsed signal separately.
 */
export function stripContinuationSignal(text: string): {
  text: string;
  signal: ContinuationSignal | null;
} {
  const signal = parseContinuationSignal(text);
  if (!signal) {
    return { text, signal: null };
  }

  let stripped: string;
  if (signal.kind === "delegate") {
    // Strip the full DELEGATE signal: single-line task + optional ---CONTEXT--- block.
    // Mirrors the parser grammar exactly.
    stripped = text.replace(
      /(?:^|\n)CONTINUE_DELEGATE:[^\n]+(?:\n---CONTEXT---(?:\n[\s\S]*)?)?\s*$/,
      "",
    );
  } else {
    // Only strip CONTINUE_WORK when it's the signal type parsed
    stripped = text.replace(/\bCONTINUE_WORK(?::\d+)?\s*$/, "");
  }
  stripped = stripped.trimEnd();

  return { text: stripped, signal };
}
