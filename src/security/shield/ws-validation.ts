// ─────────────────────────────────────────────
//  OpenClaw Shield — WebSocket Validation
//  Origin checking, payload size limiting, and
//  message schema validation for gateway WS.
//  By Kairos Lab
// ─────────────────────────────────────────────

import { createHash } from "node:crypto";

// ─── Types ───────────────────────────────────

export interface WsValidationConfig {
  /** Max payload size in bytes for authenticated connections */
  maxPayloadBytes: number;
  /** Max payload size in bytes for pre-auth connections */
  maxPreAuthPayloadBytes: number;
  /** Allowed origin hostnames (empty = allow all) */
  allowedOrigins: string[];
  /** Whether to allow connections with no origin header (e.g., non-browser clients) */
  allowMissingOrigin: boolean;
  /** Max message rate per connection per minute */
  maxMessagesPerMinute: number;
}

export interface WsValidationResult {
  valid: boolean;
  reason?: string;
}

// ─── Defaults ────────────────────────────────

export const DEFAULT_WS_VALIDATION: WsValidationConfig = {
  maxPayloadBytes: 10 * 1024 * 1024, // 10 MB
  maxPreAuthPayloadBytes: 64 * 1024, // 64 KB
  allowedOrigins: [],
  allowMissingOrigin: true, // CLI clients don't send Origin
  maxMessagesPerMinute: 300,
};

// ─── Origin Validation ──────────────────────

/**
 * Validate the Origin header of a WebSocket upgrade request.
 * Non-browser clients (CLI, mobile apps) may not send Origin —
 * allowMissingOrigin controls whether that's accepted.
 */
export function validateOrigin(
  origin: string | undefined | null,
  config: WsValidationConfig = DEFAULT_WS_VALIDATION,
): WsValidationResult {
  if (!origin) {
    return config.allowMissingOrigin
      ? { valid: true }
      : { valid: false, reason: "Missing Origin header" };
  }

  // If no allowlist configured, accept all origins
  if (config.allowedOrigins.length === 0) {
    return { valid: true };
  }

  try {
    const url = new URL(origin);
    const hostname = url.hostname;
    if (config.allowedOrigins.includes(hostname) || config.allowedOrigins.includes(origin)) {
      return { valid: true };
    }
    return { valid: false, reason: `Origin ${hostname} not in allowlist` };
  } catch {
    return { valid: false, reason: `Invalid Origin header: ${origin}` };
  }
}

// ─── Payload Validation ─────────────────────

/**
 * Validate WebSocket message payload size.
 */
export function validatePayloadSize(
  payloadBytes: number,
  authenticated: boolean,
  config: WsValidationConfig = DEFAULT_WS_VALIDATION,
): WsValidationResult {
  const limit = authenticated ? config.maxPayloadBytes : config.maxPreAuthPayloadBytes;

  if (payloadBytes > limit) {
    return {
      valid: false,
      reason: `Payload ${payloadBytes} bytes exceeds ${authenticated ? "authenticated" : "pre-auth"} limit of ${limit} bytes`,
    };
  }

  return { valid: true };
}

// ─── Rate Tracking ──────────────────────────

/**
 * Simple per-connection message rate tracker.
 * Returns a function that checks if a connection is over its rate limit.
 */
export function createConnectionRateTracker(
  maxPerMinute: number = DEFAULT_WS_VALIDATION.maxMessagesPerMinute,
): {
  check: () => WsValidationResult;
  reset: () => void;
} {
  let timestamps: number[] = [];

  function check(): WsValidationResult {
    const now = Date.now();
    const oneMinuteAgo = now - 60_000;

    // Slide window
    timestamps = timestamps.filter((ts) => ts > oneMinuteAgo);
    timestamps.push(now);

    if (timestamps.length > maxPerMinute) {
      return {
        valid: false,
        reason: `Message rate ${timestamps.length}/min exceeds limit ${maxPerMinute}/min`,
      };
    }

    return { valid: true };
  }

  function reset(): void {
    timestamps = [];
  }

  return { check, reset };
}

// ─── Device Fingerprint ─────────────────────

/**
 * Generate a device fingerprint from User-Agent string.
 * Uses SHA-256 truncated to 16 hex chars for compact storage.
 */
export function generateDeviceFingerprint(userAgent: string | undefined): string {
  if (!userAgent) {
    return "unknown";
  }
  return createHash("sha256").update(userAgent).digest("hex").slice(0, 16);
}
