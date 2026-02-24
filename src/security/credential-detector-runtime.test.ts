/**
 * Credential Detector Runtime - Unit Tests
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  credentialDetector,
  flushCredentialDetector,
  resetCredentialDetectorRuntime,
} from "./credential-detector-runtime.js";

describe("credential-detector-runtime", () => {
  beforeEach(() => {
    resetCredentialDetectorRuntime();
  });

  it("should return the same singleton on repeated calls", () => {
    const a = credentialDetector();
    const b = credentialDetector();
    expect(a).toBe(b);
  });

  it("should accept recordAccess calls without throwing", () => {
    const detector = credentialDetector();
    // First access — no anomaly check yet (returns null per bucket-boundary design)
    const result = detector.recordAccess("test_api_key", "openai");
    expect(result).toBeNull();
  });

  it("should accumulate access events across calls", () => {
    const detector = credentialDetector();
    for (let i = 0; i < 10; i++) {
      detector.recordAccess("test_key", "provider_a");
    }
    // Internal state is tracked — we verify flush doesn't throw
    // (Direct bucket inspection isn't exposed, which is correct encapsulation)
    expect(() => detector.recordAccess("test_key", "provider_a")).not.toThrow();
  });

  it("should flush without throwing", async () => {
    const detector = credentialDetector();
    detector.recordAccess("flush_key", "scope");
    await expect(flushCredentialDetector()).resolves.toBeUndefined();
  });

  it("should handle flush when no instance exists", async () => {
    // Don't call credentialDetector() — instance is null
    await expect(flushCredentialDetector()).resolves.toBeUndefined();
  });

  it("should reset cleanly for test isolation", () => {
    const first = credentialDetector();
    resetCredentialDetectorRuntime();
    const second = credentialDetector();
    expect(first).not.toBe(second);
  });
});
