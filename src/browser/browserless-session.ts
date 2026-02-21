/**
 * In-memory store for Browserless.reconnect session URLs.
 *
 * When OpenClaw disconnects from a Browserless v2 instance, it can send a
 * `Browserless.reconnect` CDP command to keep the browser alive. The command
 * returns a reconnection WebSocket URL that can be used on the next connect
 * to resume the same browser session instead of starting a fresh one.
 *
 * This module provides a simple key-value store (keyed by the profile's
 * normalized cdpUrl) with automatic expiry handling.
 */

type ReconnectEntry = {
  /** The WebSocket URL returned by Browserless.reconnect */
  wsUrl: string;
  /** Timestamp (Date.now()) when this entry expires */
  expiresAt: number;
};

const EXPIRY_SAFETY_BUFFER_MS = 2_000;

const store = new Map<string, ReconnectEntry>();

function normalizeKey(cdpUrl: string): string {
  return cdpUrl.replace(/\/+$/, "").toLowerCase();
}

/**
 * Store a reconnect URL for a given CDP endpoint.
 * Overwrites any existing entry for the same cdpUrl.
 */
export function storeReconnectUrl(cdpUrl: string, wsUrl: string, timeoutMs: number): void {
  const key = normalizeKey(cdpUrl);
  store.set(key, {
    wsUrl,
    expiresAt: Date.now() + timeoutMs,
  });
}

/**
 * Retrieve and consume a reconnect URL for a given CDP endpoint.
 * Returns null if no entry exists or if it has expired (with safety buffer).
 * The entry is deleted after retrieval (one-time use).
 */
export function getReconnectUrl(cdpUrl: string): string | null {
  const key = normalizeKey(cdpUrl);
  const entry = store.get(key);
  if (!entry) {
    return null;
  }
  // Always remove: it's either consumed or expired
  store.delete(key);
  if (Date.now() + EXPIRY_SAFETY_BUFFER_MS >= entry.expiresAt) {
    return null;
  }
  return entry.wsUrl;
}

/**
 * Explicitly clear a reconnect URL (e.g., on connection failure fallback).
 */
export function clearReconnectUrl(cdpUrl: string): void {
  store.delete(normalizeKey(cdpUrl));
}

/**
 * Extract a reconnect WebSocket URL from a Browserless.reconnect CDP response.
 * The response format may vary; this handles known shapes.
 */
export function extractReconnectUrl(result: unknown): string | null {
  if (!result || typeof result !== "object") {
    return null;
  }
  // Browserless returns { browserWSEndpoint: "ws://..." } or similar
  const obj = result as Record<string, unknown>;
  for (const key of ["browserWSEndpoint", "wsEndpoint", "webSocketDebuggerUrl"]) {
    const value = obj[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return null;
}

/** Visible for testing only. */
export function _clearAllForTesting(): void {
  store.clear();
}
