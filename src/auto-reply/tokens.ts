import { normalizeDiagnosticTraceparent } from "../infra/diagnostic-trace-context-pure.js";
import { escapeRegExp } from "../shared/regexp.js";
import {
  CONTINUATION_DELEGATE_FANOUT_MODES,
  normalizeContinuationTargetKey,
  normalizeContinuationTargetKeys,
} from "./continuation/targeting-pure.js";
import type { ContinuationSignal } from "./continuation/types.js";

export const HEARTBEAT_TOKEN = "HEARTBEAT_OK";
export const SILENT_REPLY_TOKEN = "NO_REPLY";
export const CONTINUE_WORK_TOKEN = "CONTINUE_WORK";

const silentExactRegexByToken = new Map<string, RegExp>();
const silentTrailingRegexByToken = new Map<string, RegExp>();
const silentLeadingAttachedRegexByToken = new Map<string, RegExp>();

function getSilentExactRegex(token: string): RegExp {
  const cached = silentExactRegexByToken.get(token);
  if (cached) {
    return cached;
  }
  const escaped = escapeRegExp(token);
  const regex = new RegExp(`^\\s*${escaped}\\s*$`, "i");
  silentExactRegexByToken.set(token, regex);
  return regex;
}

function getSilentTrailingRegex(token: string): RegExp {
  const cached = silentTrailingRegexByToken.get(token);
  if (cached) {
    return cached;
  }
  const escaped = escapeRegExp(token);
  const regex = new RegExp(`(?:^|\\s+|\\*+)${escaped}\\s*$`, "i");
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

type SilentReplyActionEnvelope = { action?: unknown };

function isSilentReplyEnvelopeText(
  text: string | undefined,
  token: string = SILENT_REPLY_TOKEN,
): boolean {
  if (!text) {
    return false;
  }
  const trimmed = text.trim();
  if (!trimmed || !trimmed.startsWith("{") || !trimmed.endsWith("}") || !trimmed.includes(token)) {
    return false;
  }
  try {
    const parsed = JSON.parse(trimmed) as SilentReplyActionEnvelope;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return false;
    }
    const keys = Object.keys(parsed);
    return (
      keys.length === 1 &&
      keys[0] === "action" &&
      typeof parsed.action === "string" &&
      parsed.action.trim() === token
    );
  } catch {
    return false;
  }
}

export function isSilentReplyPayloadText(
  text: string | undefined,
  token: string = SILENT_REPLY_TOKEN,
): boolean {
  return isSilentReplyText(text, token) || isSilentReplyEnvelopeText(text, token);
}

/**
 * Strip a trailing silent reply token from mixed-content text.
 * Returns the remaining text with the token removed (trimmed).
 * If the result is empty, the entire message should be treated as silent.
 */
export function stripSilentToken(text: string, token: string = SILENT_REPLY_TOKEN): string {
  return text.replace(getSilentTrailingRegex(token), "").trim();
}

const silentLeadingRegexByToken = new Map<string, RegExp>();

function getSilentLeadingAttachedRegex(token: string): RegExp {
  const cached = silentLeadingAttachedRegexByToken.get(token);
  if (cached) {
    return cached;
  }
  const escaped = escapeRegExp(token);
  // Match one or more leading occurrences of the token where the final token
  // is glued directly to visible word-start content (for example
  // `NO_REPLYhello`), without treating punctuation-start text like
  // `NO_REPLY: explanation` as a silent prefix.
  const regex = new RegExp(`^\\s*(?:${escaped}\\s+)*${escaped}(?=[\\p{L}\\p{N}])`, "iu");
  silentLeadingAttachedRegexByToken.set(token, regex);
  return regex;
}

function getSilentLeadingRegex(token: string): RegExp {
  const cached = silentLeadingRegexByToken.get(token);
  if (cached) {
    return cached;
  }
  const escaped = escapeRegExp(token);
  // Match one or more leading occurrences of the token, each optionally followed by whitespace
  const regex = new RegExp(`^(?:\\s*${escaped})+\\s*`, "i");
  silentLeadingRegexByToken.set(token, regex);
  return regex;
}

/**
 * Strip leading silent reply tokens from text.
 * Handles cases like "NO_REPLYThe user is saying..." where the token
 * is not separated from the following text.
 */
export function stripLeadingSilentToken(text: string, token: string = SILENT_REPLY_TOKEN): string {
  return text.replace(getSilentLeadingRegex(token), "").trim();
}

/**
 * Check whether text starts with one or more leading silent reply tokens where
 * the final token is glued directly to visible content.
 */
export function startsWithSilentToken(
  text: string | undefined,
  token: string = SILENT_REPLY_TOKEN,
): boolean {
  if (!text) {
    return false;
  }
  return getSilentLeadingAttachedRegex(token).test(text);
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

export type { ContinuationSignal };

type DelegateDirectiveParse = { status: "applied" } | { status: "unknown" } | { status: "invalid" };

type DelegateDirectiveState = {
  silent?: boolean;
  silentWake?: boolean;
  targetSessionKey?: string;
  targetSessionKeys?: string[];
  fanoutMode?: "tree" | "all";
  traceparent?: string;
};

function splitDirectiveAssignment(segment: string): { key: string; value: string } | null {
  const separator = segment.indexOf("=");
  if (separator < 0) {
    return null;
  }
  return {
    key: segment.slice(0, separator).trim().toLowerCase(),
    value: segment.slice(separator + 1).trim(),
  };
}

function parseDelegateDirective(
  segment: string,
  state: DelegateDirectiveState,
): DelegateDirectiveParse {
  const normalized = segment.trim().toLowerCase();
  if (!normalized) {
    return { status: "invalid" };
  }
  if (normalized === "normal") {
    return { status: "applied" };
  }
  if (normalized === "silent-wake" || normalized === "silent wake") {
    state.silentWake = true;
    state.silent = undefined;
    return { status: "applied" };
  }
  if (normalized === "silent") {
    state.silent = true;
    return { status: "applied" };
  }

  const assignment = splitDirectiveAssignment(segment);
  if (!assignment) {
    return { status: "unknown" };
  }

  if (
    assignment.key === "target" ||
    assignment.key === "targetsessionkey" ||
    assignment.key === "target_session_key"
  ) {
    const targetSessionKey = normalizeContinuationTargetKey(assignment.value);
    if (!targetSessionKey) {
      return { status: "invalid" };
    }
    state.targetSessionKey = targetSessionKey;
    return { status: "applied" };
  }

  if (
    assignment.key === "targets" ||
    assignment.key === "targetsessionkeys" ||
    assignment.key === "target_session_keys"
  ) {
    const targetSessionKeys = normalizeContinuationTargetKeys(assignment.value.split(","));
    if (targetSessionKeys.length === 0) {
      return { status: "invalid" };
    }
    state.targetSessionKeys = targetSessionKeys;
    return { status: "applied" };
  }

  if (
    assignment.key === "fanout" ||
    assignment.key === "fanoutmode" ||
    assignment.key === "fanout_mode"
  ) {
    const fanoutMode = assignment.value.trim().toLowerCase();
    if (!CONTINUATION_DELEGATE_FANOUT_MODES.includes(fanoutMode as "tree" | "all")) {
      return { status: "invalid" };
    }
    state.fanoutMode = fanoutMode as "tree" | "all";
    return { status: "applied" };
  }

  if (assignment.key === "traceparent" || assignment.key === "trace_parent") {
    const traceparent = normalizeDiagnosticTraceparent(assignment.value);
    if (traceparent) {
      state.traceparent = traceparent;
    }
    return { status: "applied" };
  }

  return { status: "unknown" };
}

function parseDelegateBodyDirectives(taskBody: string): {
  taskBody: string;
  directives: DelegateDirectiveState;
} | null {
  const segments = taskBody.split("|").map((segment) => segment.trim());
  const directives: DelegateDirectiveState = {};
  while (segments.length > 1) {
    const segment = segments.at(-1) ?? "";
    const parsed = parseDelegateDirective(segment, directives);
    if (parsed.status === "unknown") {
      break;
    }
    if (parsed.status === "invalid") {
      return null;
    }
    segments.pop();
  }
  if (
    directives.fanoutMode &&
    (directives.targetSessionKey ||
      (directives.targetSessionKeys && directives.targetSessionKeys.length > 0))
  ) {
    return null;
  }
  return {
    taskBody: segments.join(" | ").trim(),
    directives,
  };
}

/**
 * Checks if the agent response ends with a continuation signal.
 * Returns the parsed signal or null if no continuation is requested.
 *
 * Formats:
 *   CONTINUE_WORK              → continue with default delay
 *   CONTINUE_WORK:30           → continue after 30 seconds
 *   [[CONTINUE_DELEGATE: task]]      → spawn sub-agent with task immediately
 *   [[CONTINUE_DELEGATE: task +30s]] → spawn sub-agent after 30-second delay
 *   [[CONTINUE_DELEGATE: task | target=session-key]]
 *   [[CONTINUE_DELEGATE: task | targets=key1,key2]]
 *   [[CONTINUE_DELEGATE: task | fanout=tree]]
 *
 * The `+Ns` suffix on DELEGATE specifies a timer offset before the sub-agent
 * spawns (delegate-as-scheduler pattern). Timers do not survive gateway restarts.
 *
 * DELEGATE uses bracket syntax ([[...]]) following the repo convention for tokens
 * that carry body content (see reply_to, tts, line directives). Brackets naturally
 * delimit the boundary, so multiline tasks work without ambiguity.
 */
export function parseContinuationSignal(text: string | undefined): ContinuationSignal | null {
  if (!text) {
    return null;
  }

  const trimmed = text.trim();

  // Check for [[CONTINUE_DELEGATE: task]] at end of response.
  // The bracket pair [[ ... ]] delimits the body, so multiline tasks are safe.
  // The negative lookahead (?!\]\]) prevents ]] inside the body from prematurely
  // closing the bracket, and ensures we match the LAST [[CONTINUE_DELEGATE:]] when
  // the same token appears mid-text earlier in the response.
  const delegateMatch = trimmed.match(
    /\[\[\s*CONTINUE_DELEGATE:\s*((?:(?!\]\])[\s\S])+?)\s*\]\]\s*$/,
  );
  if (delegateMatch) {
    let taskBody = delegateMatch[1].trim();
    const parsedBody = parseDelegateBodyDirectives(taskBody);
    if (!parsedBody) {
      return null;
    }
    taskBody = parsedBody.taskBody;
    const { silent, silentWake, targetSessionKey, targetSessionKeys, fanoutMode, traceparent } =
      parsedBody.directives;

    // Parse optional +Ns delay suffix (e.g. "+30s", "+5s")
    let delayMs: number | undefined;
    const delayMatch = taskBody.match(/\s+\+(\d+)s\s*$/);
    if (delayMatch) {
      delayMs = Number.parseInt(delayMatch[1], 10) * 1000;
      taskBody = taskBody.slice(0, -delayMatch[0].length).trimEnd();
    }
    if (taskBody) {
      // Truncate overly long task strings to prevent context-dumping patterns.
      // Same limit as the continue_delegate tool schema (4096 chars).
      const maxTaskLength = 4096;
      const truncatedTask =
        taskBody.length > maxTaskLength ? taskBody.slice(0, maxTaskLength) : taskBody;
      return {
        kind: "delegate",
        task: truncatedTask,
        delayMs,
        silent,
        silentWake,
        ...(targetSessionKey ? { targetSessionKey } : {}),
        ...(targetSessionKeys && targetSessionKeys.length > 0 ? { targetSessionKeys } : {}),
        ...(fanoutMode ? { fanoutMode } : {}),
        ...(traceparent ? { traceparent } : {}),
      };
    }
  }

  // Check for CONTINUE_WORK or CONTINUE_WORK:<delay> at end of response
  const workMatch = trimmed.match(/\bCONTINUE_WORK(?::(\d+))?\s*$/);
  if (workMatch) {
    const delaySec = workMatch[1] ? Number.parseInt(workMatch[1], 10) : undefined;
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
    // Strip the [[CONTINUE_DELEGATE: ...]] bracket directive.
    // Mirrors the parser grammar exactly.
    stripped = text.replace(/\[\[\s*CONTINUE_DELEGATE:\s*(?:(?!\]\])[\s\S])+?\s*\]\]\s*$/, "");
  } else {
    // Only strip CONTINUE_WORK when it's the signal type parsed
    stripped = text.replace(/\bCONTINUE_WORK(?::\d+)?\s*$/, "");
  }
  stripped = stripped.trimEnd();

  return { text: stripped, signal };
}
