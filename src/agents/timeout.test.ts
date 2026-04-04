import { describe, expect, it } from "vitest";
import { resolveAgentTimeoutSeconds, resolveAgentTimeoutMs } from "./timeout.js";

describe("resolveAgentTimeoutSeconds", () => {
  it("returns configured timeout when set", () => {
    const cfg = { agents: { defaults: { timeoutSeconds: 3600 } } } as any;
    expect(resolveAgentTimeoutSeconds(cfg)).toBe(3600);
  });

  it("returns minimum of 1 for zero or negative", () => {
    expect(resolveAgentTimeoutSeconds({ agents: { defaults: { timeoutSeconds: 0 } } } as any)).toBe(1);
    expect(resolveAgentTimeoutSeconds({ agents: { defaults: { timeoutSeconds: -1 } } } as any)).toBe(1);
  });

  it("floors decimal values", () => {
    const cfg = { agents: { defaults: { timeoutSeconds: 100.9 } } } as any;
    expect(resolveAgentTimeoutSeconds(cfg)).toBe(100);
  });

  it("returns default for undefined config", () => {
    expect(resolveAgentTimeoutSeconds(undefined)).toBe(48 * 60 * 60);
  });

  it("returns default for missing timeoutSeconds", () => {
    expect(resolveAgentTimeoutSeconds({ agents: {} } as any)).toBe(48 * 60 * 60);
    expect(resolveAgentTimeoutSeconds({} as any)).toBe(48 * 60 * 60);
  });
});

describe("resolveAgentTimeoutMs", () => {
  const MAX_SAFE_TIMEOUT_MS = 2_147_000_000;

  it("converts seconds to milliseconds", () => {
    expect(resolveAgentTimeoutMs({ cfg: { agents: { defaults: { timeoutSeconds: 10 } } } as any }))
      .toBe(10000);
  });

  it("uses overrideMs when provided", () => {
    expect(resolveAgentTimeoutMs({ overrideMs: 5000 })).toBe(5000);
    expect(resolveAgentTimeoutMs({ overrideMs: 100 })).toBe(100);
  });

  it("uses overrideSeconds when provided", () => {
    expect(resolveAgentTimeoutMs({ overrideSeconds: 5 })).toBe(5000);
  });

  it("overrideMs takes precedence over overrideSeconds", () => {
    const result = resolveAgentTimeoutMs({ overrideMs: 3000, overrideSeconds: 10 });
    expect(result).toBe(3000);
  });

  it("returns MAX_SAFE_TIMEOUT_MS for zero override", () => {
    expect(resolveAgentTimeoutMs({ overrideMs: 0 })).toBe(MAX_SAFE_TIMEOUT_MS);
    expect(resolveAgentTimeoutMs({ overrideSeconds: 0 })).toBe(MAX_SAFE_TIMEOUT_MS);
  });

  it("returns default for negative override", () => {
    const defaultMs = resolveAgentTimeoutMs({});
    expect(resolveAgentTimeoutMs({ overrideMs: -1 })).toBe(defaultMs);
    expect(resolveAgentTimeoutMs({ overrideSeconds: -1 })).toBe(defaultMs);
  });

  it("respects minMs parameter", () => {
    const result = resolveAgentTimeoutMs({ overrideMs: 50, minMs: 100 });
    expect(result).toBe(100);
  });

  it("clamps large values to MAX_SAFE_TIMEOUT_MS", () => {
    const result = resolveAgentTimeoutMs({ overrideMs: Number.MAX_SAFE_INTEGER });
    expect(result).toBeLessThanOrEqual(MAX_SAFE_TIMEOUT_MS);
  });
});
