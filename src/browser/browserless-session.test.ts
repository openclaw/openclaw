import { afterEach, describe, expect, it, vi } from "vitest";
import {
  _clearAllForTesting,
  clearReconnectUrl,
  extractReconnectUrl,
  getReconnectUrl,
  storeReconnectUrl,
} from "./browserless-session.js";

describe("browserless-session", () => {
  afterEach(() => {
    _clearAllForTesting();
    vi.useRealTimers();
  });

  // ── Store and retrieve ──────────────────────────────────────────────

  it("stores and retrieves a reconnect URL", () => {
    storeReconnectUrl("http://remote:9222", "ws://remote:9222/devtools/browser/A", 60_000);
    expect(getReconnectUrl("http://remote:9222")).toBe("ws://remote:9222/devtools/browser/A");
  });

  // ── One-time use ────────────────────────────────────────────────────

  it("returns null on second retrieval (one-time use)", () => {
    storeReconnectUrl("http://remote:9222", "ws://remote:9222/devtools/browser/B", 60_000);
    expect(getReconnectUrl("http://remote:9222")).toBe("ws://remote:9222/devtools/browser/B");
    expect(getReconnectUrl("http://remote:9222")).toBeNull();
  });

  // ── Key normalization ───────────────────────────────────────────────

  it("normalizes trailing slashes on the key", () => {
    storeReconnectUrl("http://remote:9222/", "ws://remote:9222/devtools/browser/C", 60_000);
    expect(getReconnectUrl("http://remote:9222")).toBe("ws://remote:9222/devtools/browser/C");
  });

  it("normalizes trailing slashes on lookup", () => {
    storeReconnectUrl("http://remote:9222", "ws://remote:9222/devtools/browser/D", 60_000);
    expect(getReconnectUrl("http://remote:9222/")).toBe("ws://remote:9222/devtools/browser/D");
  });

  it("normalizes case on the key", () => {
    storeReconnectUrl("HTTP://REMOTE:9222", "ws://remote:9222/devtools/browser/E", 60_000);
    expect(getReconnectUrl("http://remote:9222")).toBe("ws://remote:9222/devtools/browser/E");
  });

  it("normalizes case on lookup", () => {
    storeReconnectUrl("http://remote:9222", "ws://remote:9222/devtools/browser/F", 60_000);
    expect(getReconnectUrl("HTTP://REMOTE:9222")).toBe("ws://remote:9222/devtools/browser/F");
  });

  it("normalizes both case and trailing slashes together", () => {
    storeReconnectUrl("HTTP://REMOTE:9222///", "ws://val", 60_000);
    expect(getReconnectUrl("http://remote:9222")).toBe("ws://val");
  });

  // ── Expired entry ──────────────────────────────────────────────────

  it("returns null when the entry has expired", () => {
    vi.useFakeTimers();
    storeReconnectUrl("http://remote:9222", "ws://remote:9222/devtools/browser/G", 5_000);

    // Advance past expiry
    vi.advanceTimersByTime(6_000);

    expect(getReconnectUrl("http://remote:9222")).toBeNull();
  });

  it("returns the URL when still within the timeout minus safety buffer", () => {
    vi.useFakeTimers();
    storeReconnectUrl("http://remote:9222", "ws://remote:9222/devtools/browser/H", 10_000);

    // Advance to 7s — well within the 10s timeout minus 2s safety buffer
    vi.advanceTimersByTime(7_000);

    expect(getReconnectUrl("http://remote:9222")).toBe("ws://remote:9222/devtools/browser/H");
  });

  // ── Safety buffer ──────────────────────────────────────────────────

  it("returns null when current time + 2s safety buffer >= expiresAt", () => {
    vi.useFakeTimers();
    storeReconnectUrl("http://remote:9222", "ws://remote:9222/devtools/browser/I", 5_000);

    // Advance to 3001ms — now Date.now() + 2000 = 5001 >= expiresAt (5000)
    vi.advanceTimersByTime(3_001);

    expect(getReconnectUrl("http://remote:9222")).toBeNull();
  });

  it("returns null when exactly at the safety buffer boundary", () => {
    vi.useFakeTimers();
    storeReconnectUrl("http://remote:9222", "ws://val", 5_000);

    // Advance to 3000ms — Date.now() + 2000 = 5000 >= expiresAt (5000)
    vi.advanceTimersByTime(3_000);

    expect(getReconnectUrl("http://remote:9222")).toBeNull();
  });

  it("returns the URL at 1ms before the safety buffer boundary", () => {
    vi.useFakeTimers();
    storeReconnectUrl("http://remote:9222", "ws://val", 5_000);

    // Advance to 2999ms — Date.now() + 2000 = 4999 < expiresAt (5000)
    vi.advanceTimersByTime(2_999);

    expect(getReconnectUrl("http://remote:9222")).toBe("ws://val");
  });

  // ── Expired entry is also removed from the store ───────────────────

  it("removes expired entries from the store on get", () => {
    vi.useFakeTimers();
    storeReconnectUrl("http://remote:9222", "ws://val", 1_000);
    vi.advanceTimersByTime(5_000);

    // First get: returns null (expired), entry removed
    expect(getReconnectUrl("http://remote:9222")).toBeNull();

    // Store a fresh entry to confirm the old one is truly gone
    storeReconnectUrl("http://remote:9222", "ws://new-val", 60_000);
    expect(getReconnectUrl("http://remote:9222")).toBe("ws://new-val");
  });

  // ── clearReconnectUrl ──────────────────────────────────────────────

  it("clears a stored entry", () => {
    storeReconnectUrl("http://remote:9222", "ws://val", 60_000);
    clearReconnectUrl("http://remote:9222");
    expect(getReconnectUrl("http://remote:9222")).toBeNull();
  });

  it("does not throw when clearing a non-existent entry", () => {
    expect(() => clearReconnectUrl("http://nonexistent:9222")).not.toThrow();
  });

  it("normalizes the key when clearing", () => {
    storeReconnectUrl("http://remote:9222", "ws://val", 60_000);
    clearReconnectUrl("HTTP://REMOTE:9222/");
    expect(getReconnectUrl("http://remote:9222")).toBeNull();
  });

  // ── Overwrite ──────────────────────────────────────────────────────

  it("overwrites an existing entry for the same key", () => {
    storeReconnectUrl("http://remote:9222", "ws://first", 60_000);
    storeReconnectUrl("http://remote:9222", "ws://second", 60_000);
    expect(getReconnectUrl("http://remote:9222")).toBe("ws://second");
  });

  it("overwrites via a normalized key variant", () => {
    storeReconnectUrl("http://remote:9222/", "ws://first", 60_000);
    storeReconnectUrl("HTTP://REMOTE:9222", "ws://second", 60_000);
    expect(getReconnectUrl("http://remote:9222")).toBe("ws://second");
  });

  // ── extractReconnectUrl ────────────────────────────────────────────

  describe("extractReconnectUrl", () => {
    it("extracts browserWSEndpoint", () => {
      expect(
        extractReconnectUrl({ browserWSEndpoint: "ws://host:9222/devtools/browser/X" }),
      ).toBe("ws://host:9222/devtools/browser/X");
    });

    it("extracts wsEndpoint", () => {
      expect(extractReconnectUrl({ wsEndpoint: "ws://host:9222/ws" })).toBe(
        "ws://host:9222/ws",
      );
    });

    it("extracts webSocketDebuggerUrl", () => {
      expect(
        extractReconnectUrl({ webSocketDebuggerUrl: "ws://host:9222/devtools/browser/Y" }),
      ).toBe("ws://host:9222/devtools/browser/Y");
    });

    it("prefers browserWSEndpoint over wsEndpoint", () => {
      expect(
        extractReconnectUrl({
          browserWSEndpoint: "ws://preferred",
          wsEndpoint: "ws://fallback",
        }),
      ).toBe("ws://preferred");
    });

    it("prefers wsEndpoint over webSocketDebuggerUrl", () => {
      expect(
        extractReconnectUrl({
          wsEndpoint: "ws://preferred",
          webSocketDebuggerUrl: "ws://fallback",
        }),
      ).toBe("ws://preferred");
    });

    it("trims whitespace from extracted URL", () => {
      expect(
        extractReconnectUrl({ browserWSEndpoint: "  ws://host:9222/devtools/browser/Z  " }),
      ).toBe("ws://host:9222/devtools/browser/Z");
    });

    // Null cases
    it("returns null for null input", () => {
      expect(extractReconnectUrl(null)).toBeNull();
    });

    it("returns null for undefined input", () => {
      expect(extractReconnectUrl(undefined)).toBeNull();
    });

    it("returns null for non-object input (string)", () => {
      expect(extractReconnectUrl("ws://something")).toBeNull();
    });

    it("returns null for non-object input (number)", () => {
      expect(extractReconnectUrl(42)).toBeNull();
    });

    it("returns null for non-object input (boolean)", () => {
      expect(extractReconnectUrl(true)).toBeNull();
    });

    it("returns null for empty object", () => {
      expect(extractReconnectUrl({})).toBeNull();
    });

    it("returns null when known keys have empty string values", () => {
      expect(extractReconnectUrl({ browserWSEndpoint: "" })).toBeNull();
    });

    it("returns null when known keys have whitespace-only values", () => {
      expect(extractReconnectUrl({ browserWSEndpoint: "   " })).toBeNull();
    });

    it("returns null when known keys have non-string values", () => {
      expect(extractReconnectUrl({ browserWSEndpoint: 123 })).toBeNull();
    });

    it("returns null for object with unrecognized keys only", () => {
      expect(extractReconnectUrl({ someOtherKey: "ws://something" })).toBeNull();
    });
  });

  // ── _clearAllForTesting ────────────────────────────────────────────

  it("clears all stored entries", () => {
    storeReconnectUrl("http://host-a:9222", "ws://a", 60_000);
    storeReconnectUrl("http://host-b:9222", "ws://b", 60_000);
    storeReconnectUrl("http://host-c:9222", "ws://c", 60_000);

    _clearAllForTesting();

    expect(getReconnectUrl("http://host-a:9222")).toBeNull();
    expect(getReconnectUrl("http://host-b:9222")).toBeNull();
    expect(getReconnectUrl("http://host-c:9222")).toBeNull();
  });

  // ── get returns null for missing key ───────────────────────────────

  it("returns null when no entry exists for the key", () => {
    expect(getReconnectUrl("http://never-stored:9222")).toBeNull();
  });
});
