/**
 * Outbound WebSocket redaction pipeline.
 *
 * Fixes issue #70645: LLM reasoning prose leaked to channel plugins (Telegram,
 * Discord, etc.) through the WebSocket outbound stream when an approval-pending
 * prompt was triggered.  Previously `logging.redactPatterns` only applied to
 * file/journal logs; the outbound stream was unfiltered.
 *
 * This module provides two layers of protection applied before a frame is sent:
 *
 * 1. `redactPatterns` / sensitive-token redaction — the same patterns already
 *    used by the logging pipeline are now also applied to the serialised JSON
 *    frame, so any credential or token that appears anywhere in an outbound
 *    event is masked before it leaves the gateway process.
 *
 * 2. Reasoning-prose strip — for exec.approval.requested and
 *    plugin.approval.requested events the LLM's internal reasoning can appear
 *    in the `ask` / `description` fields as free-form text that precedes the
 *    actual "Approval required" sentence.  The routine below strips everything
 *    before the first occurrence of that sentinel so channel plugins only
 *    receive the human-readable approval notice, not the model's chain-of-thought.
 */

import { redactSensitiveText, resolveRedactOptions } from "../logging/redact.js";
import type { ResolvedRedactOptions } from "../logging/redact.js";

// ---------------------------------------------------------------------------
// Reasoning-prose strip
// ---------------------------------------------------------------------------

/**
 * Pattern that marks the start of the human-facing approval notice inside a
 * free-form `ask` / `description` string.  Everything before the first match
 * is considered LLM reasoning and is stripped.
 *
 * Matches case-insensitively so variations like "approval Required" are caught.
 */
const APPROVAL_REQUIRED_SENTINEL_RE = /approval\s+required/i;

/**
 * Strip reasoning prose that precedes the "Approval required" sentinel in a
 * string field.  If the sentinel is absent the original string is returned
 * unchanged so we never accidentally suppress a legitimate description.
 */
export function stripReasoningProseBeforeApprovalSentinel(text: string): string {
  const match = APPROVAL_REQUIRED_SENTINEL_RE.exec(text);
  if (!match || match.index === 0) {
    return text;
  }
  return text.slice(match.index);
}

// ---------------------------------------------------------------------------
// Approval event field sanitisation
// ---------------------------------------------------------------------------

const EXEC_APPROVAL_REQUESTED = "exec.approval.requested";
const PLUGIN_APPROVAL_REQUESTED = "plugin.approval.requested";

/**
 * Sanitise the mutable payload of an approval event in-place.
 *
 * For exec approvals the `ask` field on `payload.request` may contain
 * reasoning prose.  For plugin approvals the `description` field may.
 * Both are trimmed so only the human-visible part reaches channel plugins.
 */
function sanitiseApprovalPayload(event: string, payload: unknown): unknown {
  if (event !== EXEC_APPROVAL_REQUESTED && event !== PLUGIN_APPROVAL_REQUESTED) {
    return payload;
  }
  if (!payload || typeof payload !== "object") {
    return payload;
  }
  const obj = payload as Record<string, unknown>;
  const request = obj.request;
  if (!request || typeof request !== "object") {
    return payload;
  }
  const req = request as Record<string, unknown>;

  if (event === EXEC_APPROVAL_REQUESTED) {
    if (typeof req.ask === "string" && req.ask) {
      const cleaned = stripReasoningProseBeforeApprovalSentinel(req.ask);
      if (cleaned !== req.ask) {
        return {
          ...obj,
          request: { ...req, ask: cleaned },
        };
      }
    }
  } else {
    // plugin.approval.requested
    if (typeof req.description === "string" && req.description) {
      const cleaned = stripReasoningProseBeforeApprovalSentinel(req.description);
      if (cleaned !== req.description) {
        return {
          ...obj,
          request: { ...req, description: cleaned },
        };
      }
    }
  }
  return payload;
}

// ---------------------------------------------------------------------------
// Frame-level redaction
// ---------------------------------------------------------------------------

/**
 * Return the resolved redact options.  Re-resolves from config on every call
 * so hot-reloads (openclaw reload) take effect without restarting.
 */
function getRedactOptions(): ResolvedRedactOptions {
  return resolveRedactOptions();
}

/**
 * Apply the outbound redaction pipeline to a serialised WebSocket frame.
 *
 * Applies pattern-based token/credential masking over the raw JSON string.
 * Call this after JSON.stringify and before socket.send.
 */
export function redactOutboundFrame(frame: string): string {
  const opts = getRedactOptions();
  if (opts.mode === "off" || opts.patterns.length === 0) {
    return frame;
  }
  return redactSensitiveText(frame, opts);
}

/**
 * Prepare an outbound event for dispatch:
 *  1. Sanitise approval-event fields to strip reasoning prose.
 *  2. Serialise to JSON.
 *  3. Apply the redactPatterns pipeline over the resulting JSON string.
 *
 * Returns the frame string ready for socket.send.
 */
export function buildRedactedFrame(params: {
  type: string;
  event: string;
  payload: unknown;
  seq: number | undefined;
  stateVersion: unknown;
}): string {
  const sanitisedPayload = sanitiseApprovalPayload(params.event, params.payload);
  const raw = JSON.stringify({
    type: params.type,
    event: params.event,
    payload: sanitisedPayload,
    seq: params.seq,
    stateVersion: params.stateVersion,
  });
  return redactOutboundFrame(raw);
}
