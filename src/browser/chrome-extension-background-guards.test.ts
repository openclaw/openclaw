/**
 * Tests for Chrome extension relay guards introduced by #40037:
 *
 * 1. Last-tab guard: Target.closeTarget refuses to close the final tab.
 * 2. Rehydration retry: validateAttachedTab retries once before dropping a tab.
 * 3. reannounceAttachedTabs: validates + retries before removing tabs.
 *
 * These tests exercise the pure-logic helpers exported from background-utils.js
 * and verify the guard contracts documented in #40037.  The background.js
 * functions themselves depend on chrome.* APIs and are tested indirectly
 * through the util layer they delegate to.
 */

import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

type BackgroundUtilsModule = {
  isLastRemainingTab: (
    allTabs: Array<{ id?: number | undefined } | null | undefined>,
    tabIdToClose: number,
  ) => boolean;
  isMissingTabError: (err: unknown) => boolean;
  isRetryableReconnectError: (err: unknown) => boolean;
  reconnectDelayMs: (
    attempt: number,
    opts?: { baseMs?: number; maxMs?: number; jitterMs?: number; random?: () => number },
  ) => number;
};

const require = createRequire(import.meta.url);
const BACKGROUND_UTILS_MODULE = "../../assets/chrome-extension/background-utils.js";

async function loadBackgroundUtils(): Promise<BackgroundUtilsModule> {
  try {
    return require(BACKGROUND_UTILS_MODULE) as BackgroundUtilsModule;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes("Unexpected token 'export'")) {
      throw error;
    }
    return (await import(BACKGROUND_UTILS_MODULE)) as BackgroundUtilsModule;
  }
}

const { isLastRemainingTab, isMissingTabError, reconnectDelayMs } = await loadBackgroundUtils();

// ---------------------------------------------------------------------------
// Bug 1 — Last-tab guard (#40037)
//
// The closeTarget handler in background.js calls isLastRemainingTab() before
// chrome.tabs.remove().  These tests prove the guard catches every edge case.
// ---------------------------------------------------------------------------

describe("last-tab guard (closeTarget safety)", () => {
  it("blocks closing when only one tab exists", () => {
    expect(isLastRemainingTab([{ id: 1 }], 1)).toBe(true);
  });

  it("allows closing when other tabs remain", () => {
    expect(isLastRemainingTab([{ id: 1 }, { id: 2 }], 1)).toBe(false);
    expect(isLastRemainingTab([{ id: 1 }, { id: 2 }, { id: 3 }], 2)).toBe(false);
  });

  it("blocks closing when tab-to-close is the only non-null entry", () => {
    // chrome.tabs.query can return sparse/null entries in edge cases
    expect(isLastRemainingTab([null, { id: 5 }, undefined], 5)).toBe(true);
  });

  it("allows closing when another valid tab exists alongside nulls", () => {
    expect(isLastRemainingTab([null, { id: 5 }, { id: 6 }], 5)).toBe(false);
  });

  it("treats undefined-id tab entries as non-closeable", () => {
    // Target.closeTarget always calls chrome.tabs.remove with a concrete numeric id.
    // Undefined-id entries from chrome.tabs.query are not actionable fallback tabs.
    expect(isLastRemainingTab([{ id: undefined }, { id: 7 }], 7)).toBe(true);
  });

  it("blocks when allTabs is not an array (defensive)", () => {
    // @ts-expect-error — testing runtime defense
    expect(isLastRemainingTab(null, 1)).toBe(true);
    // @ts-expect-error — testing runtime defense
    expect(isLastRemainingTab(undefined, 1)).toBe(true);
  });

  it("blocks when allTabs is empty", () => {
    expect(isLastRemainingTab([], 1)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Bug 2 — Rehydration retry (#40037)
//
// validateAttachedTab (background.js:65) uses TAB_VALIDATION_ATTEMPTS=2 and
// TAB_VALIDATION_RETRY_DELAY_MS=1000 to retry once before permanently
// dropping a tab.  The retry protects against transient failures during
// MV3 service worker restarts.
//
// Since validateAttachedTab depends on chrome.debugger.sendCommand, we test
// the error-classification helper (isMissingTabError) that controls whether
// a retry is even attempted:
//   - Missing-tab errors → no retry, tab is gone
//   - Other errors (busy, navigating) → retry once after 1s delay
// ---------------------------------------------------------------------------

describe("rehydration retry error classification", () => {
  it("detects missing-tab errors (no retry)", () => {
    expect(isMissingTabError(new Error("No tab with id: 42"))).toBe(true);
    expect(isMissingTabError(new Error("No tab with given id"))).toBe(true);
    expect(isMissingTabError(new Error("Tab not found"))).toBe(true);
  });

  it("classifies transient errors as retryable", () => {
    // These should NOT be classified as missing-tab errors,
    // so validateAttachedTab will retry instead of giving up immediately
    expect(isMissingTabError(new Error("Cannot access a chrome:// URL"))).toBe(false);
    expect(isMissingTabError(new Error("Inspected target navigated or closed"))).toBe(false);
    expect(isMissingTabError(new Error("Could not establish connection"))).toBe(false);
    expect(isMissingTabError(new Error("Debugger is not attached to the tab"))).toBe(false);
  });

  it("handles non-Error values gracefully", () => {
    expect(isMissingTabError("No tab with id: 42")).toBe(true);
    expect(isMissingTabError(null)).toBe(false);
    expect(isMissingTabError(undefined)).toBe(false);
    expect(isMissingTabError(42)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Reconnect backoff (#40037 related — relay reconnect after tab drops)
//
// When the relay WebSocket drops (often after a rehydration failure cascade),
// the extension uses exponential backoff with jitter to reconnect.  These
// tests verify the backoff curve stays within safe bounds.
// ---------------------------------------------------------------------------

describe("relay reconnect backoff", () => {
  const noJitter = { baseMs: 1000, maxMs: 30000, jitterMs: 0, random: () => 0 };

  it("starts at base delay for attempt 0", () => {
    expect(reconnectDelayMs(0, noJitter)).toBe(1000);
  });

  it("doubles each attempt", () => {
    expect(reconnectDelayMs(1, noJitter)).toBe(2000);
    expect(reconnectDelayMs(2, noJitter)).toBe(4000);
    expect(reconnectDelayMs(3, noJitter)).toBe(8000);
  });

  it("caps at maxMs regardless of attempt count", () => {
    expect(reconnectDelayMs(100, noJitter)).toBe(30000);
  });

  it("adds bounded jitter", () => {
    const withJitter = { baseMs: 1000, maxMs: 30000, jitterMs: 2000, random: () => 0.5 };
    // attempt 0: base 1000 + jitter 2000*0.5 = 2000
    expect(reconnectDelayMs(0, withJitter)).toBe(2000);
  });

  it("never returns negative values for negative attempts", () => {
    expect(reconnectDelayMs(-5, noJitter)).toBeGreaterThanOrEqual(0);
  });
});
