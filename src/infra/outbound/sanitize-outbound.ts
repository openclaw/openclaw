/**
 * Centralized outbound text sanitization gate.
 *
 * Every message leaving the gateway passes through `sanitizeOutboundText()`
 * before hitting any channel send function.  This is the single point of
 * control that prevents internal errors, raw API payloads, and metadata
 * from leaking to end-users.
 *
 * Related issues: #7867, #9951, #11038, #16673, #18937, #20004, #20279
 */

import {
  isRawApiErrorPayload,
  isContextOverflowError,
  isRateLimitErrorMessage,
  isBillingErrorMessage,
  isTimeoutErrorMessage,
  isOverloadedErrorMessage,
  isCloudflareOrHtmlErrorPage,
  formatRawAssistantErrorForUi,
  formatBillingErrorMessage,
} from "../../agents/pi-embedded-helpers/errors.js";

// ── Patterns that indicate leaked internal content ──────────────────

/** Internal [openclaw] prefixed system messages that should never reach users */
const INTERNAL_PREFIX_RE = /^\[openclaw\]\s*⚠️?\s*🛠️?\s*(?:Exec|Tool|Command)/i;

/** Stack traces */
const STACK_TRACE_RE = /^\s*at\s+[\w$.]+\s+\(.*:\d+:\d+\)/m;

/** Conversation metadata leak (untrusted metadata headers from inbound context) */
const METADATA_LEAK_RE =
  /Conversation info \(untrusted metadata\)|Sender \(untrusted metadata\)|"schema"\s*:\s*"openclaw\.inbound_meta/;

/** HTTP status code prefix with raw body */
const HTTP_ERROR_BODY_RE = /^(?:HTTP\s*)?\d{3}\s+\{[\s\S]*\}\s*$/;

// ── Public API ──────────────────────────────────────────────────────

/**
 * Sanitize text before it is sent to any outbound channel.
 *
 * Returns the original text unchanged when it looks safe, or a
 * rewritten user-friendly message when it matches a known leak pattern.
 */
export function sanitizeOutboundText(text: string): string {
  if (!text) {
    return text;
  }

  const trimmed = text.trim();
  if (!trimmed) {
    return text;
  }

  // ── Fast path: most messages are normal assistant text ──────────
  // Only run expensive checks when the text looks suspicious.
  if (!looksLikeLeakedContent(trimmed)) {
    return text;
  }

  // ── Context overflow ───────────────────────────────────────────
  if (isContextOverflowError(trimmed)) {
    return (
      "Context overflow: prompt too large for the model. " +
      "Try /reset (or /new) to start a fresh session, or use a larger-context model."
    );
  }

  // ── Rate limit / overloaded ────────────────────────────────────
  if (isRateLimitErrorMessage(trimmed)) {
    return "⚠️ API rate limit reached. Please try again later.";
  }
  if (isOverloadedErrorMessage(trimmed)) {
    return "The AI service is temporarily overloaded. Please try again in a moment.";
  }

  // ── Billing ────────────────────────────────────────────────────
  if (isBillingErrorMessage(trimmed)) {
    return formatBillingErrorMessage();
  }

  // ── Timeout ────────────────────────────────────────────────────
  if (isTimeoutErrorMessage(trimmed)) {
    return "LLM request timed out.";
  }

  // ── Cloudflare / HTML error pages ──────────────────────────────
  if (isCloudflareOrHtmlErrorPage(trimmed)) {
    return "The AI service is temporarily unavailable. Please try again in a moment.";
  }

  // ── Raw API JSON error payloads ────────────────────────────────
  if (isRawApiErrorPayload(trimmed)) {
    return formatRawAssistantErrorForUi(trimmed);
  }

  // ── Internal [openclaw] system messages ────────────────────────
  if (INTERNAL_PREFIX_RE.test(trimmed)) {
    return "⚠️ An internal error occurred. Please try again.";
  }

  // ── Conversation metadata / PII leak ───────────────────────────
  if (METADATA_LEAK_RE.test(trimmed)) {
    return "⚠️ An internal error occurred. Please try again.";
  }

  // ── Stack traces ───────────────────────────────────────────────
  if (STACK_TRACE_RE.test(trimmed)) {
    return "⚠️ An internal error occurred. Please try again.";
  }

  // ── HTTP error with raw JSON body ──────────────────────────────
  if (HTTP_ERROR_BODY_RE.test(trimmed)) {
    return formatRawAssistantErrorForUi(trimmed);
  }

  return text;
}

// ── Heuristic pre-filter ────────────────────────────────────────────

/**
 * Quick check to decide whether the text *might* contain leaked content.
 * Avoids running all the regex checks on normal assistant messages.
 */
function looksLikeLeakedContent(text: string): boolean {
  // Short texts are unlikely to be leaked payloads
  if (text.length < 20) {
    return false;
  }

  const lower = text.toLowerCase();
  return (
    lower.includes("error") ||
    lower.includes("rate limit") ||
    lower.includes("context") ||
    lower.includes("overflow") ||
    lower.includes("timeout") ||
    lower.includes("timed out") ||
    lower.includes("overloaded") ||
    lower.includes("billing") ||
    lower.includes("credits") ||
    lower.includes("[openclaw]") ||
    lower.includes("untrusted metadata") ||
    lower.includes("inbound_meta") ||
    lower.startsWith("{") ||
    text.includes("at ") ||
    lower.includes("<!doctype") ||
    lower.includes("<html")
  );
}
