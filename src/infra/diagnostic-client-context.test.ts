import { describe, expect, it } from "vitest";
import {
  CLIENT_CONTEXT_MAX_BYTES,
  CLIENT_CONTEXT_MAX_DEPTH,
  CLIENT_CONTEXT_MAX_KEYS,
  normalizeDiagnosticClientContext,
} from "./diagnostic-client-context.js";

describe("normalizeDiagnosticClientContext", () => {
  it("passes a small JSON object through and freezes it", () => {
    const result = normalizeDiagnosticClientContext({
      schemaVersion: "agentweave.context.v1",
      source: "paperclip",
      sessionId: "run-1",
    });
    expect(result).toEqual({
      schemaVersion: "agentweave.context.v1",
      source: "paperclip",
      sessionId: "run-1",
    });
    expect(Object.isFrozen(result)).toBe(true);
  });

  it("preserves nested objects, arrays, and JSON primitives", () => {
    const result = normalizeDiagnosticClientContext({
      paperclip: { runId: "abc", issueId: null, turnDepth: 2 },
      issueIds: ["a", "b"],
      enabled: true,
    });
    expect(result).toEqual({
      paperclip: { runId: "abc", issueId: null, turnDepth: 2 },
      issueIds: ["a", "b"],
      enabled: true,
    });
  });

  it("orders object keys deterministically at every level", () => {
    const result = normalizeDiagnosticClientContext({
      b: 1,
      a: { z: 1, y: 2 },
    });
    expect(JSON.stringify(result)).toBe('{"a":{"y":2,"z":1},"b":1}');
  });

  it("returns undefined for non-object input", () => {
    expect(normalizeDiagnosticClientContext("nope")).toBeUndefined();
    expect(normalizeDiagnosticClientContext(42)).toBeUndefined();
    expect(normalizeDiagnosticClientContext(null)).toBeUndefined();
    expect(normalizeDiagnosticClientContext(["a"])).toBeUndefined();
    expect(normalizeDiagnosticClientContext(undefined)).toBeUndefined();
  });

  it("returns undefined for an empty object", () => {
    expect(normalizeDiagnosticClientContext({})).toBeUndefined();
  });

  it("omits prototype-polluting keys", () => {
    const parsed = JSON.parse('{"__proto__": {"polluted": true}, "ok": 1}');
    expect(normalizeDiagnosticClientContext(parsed)).toEqual({ ok: 1 });
  });

  it("rejects the whole bag when a value is not JSON-serializable", () => {
    expect(normalizeDiagnosticClientContext({ a: 1, b: () => {} })).toBeUndefined();
    expect(normalizeDiagnosticClientContext({ a: Number.NaN })).toBeUndefined();
    expect(normalizeDiagnosticClientContext({ a: Number.POSITIVE_INFINITY })).toBeUndefined();
  });

  it("rejects nesting deeper than the depth cap", () => {
    let deep: Record<string, unknown> = { leaf: 1 };
    for (let i = 0; i < CLIENT_CONTEXT_MAX_DEPTH + 1; i++) {
      deep = { nested: deep };
    }
    expect(normalizeDiagnosticClientContext(deep)).toBeUndefined();
  });

  it("rejects bags with more keys than the key cap", () => {
    const big: Record<string, number> = {};
    for (let i = 0; i < CLIENT_CONTEXT_MAX_KEYS + 1; i++) {
      big[`k${i}`] = i;
    }
    expect(normalizeDiagnosticClientContext(big)).toBeUndefined();
  });

  it("rejects bags larger than the byte cap", () => {
    const huge = { blob: "x".repeat(CLIENT_CONTEXT_MAX_BYTES + 1) };
    expect(normalizeDiagnosticClientContext(huge)).toBeUndefined();
  });

  it("measures the byte cap in UTF-8 bytes, not UTF-16 code units", () => {
    // "中" is 3 UTF-8 bytes but 1 string-length unit. Pick a count that
    // stays under the cap by code-unit length yet exceeds it by encoded bytes,
    // so a length-based check would wrongly accept it.
    const charCount = Math.floor(CLIENT_CONTEXT_MAX_BYTES / 2);
    const bag = { blob: "中".repeat(charCount) };
    expect(bag.blob.length).toBeLessThan(CLIENT_CONTEXT_MAX_BYTES);
    expect(Buffer.byteLength(JSON.stringify(bag), "utf8")).toBeGreaterThan(
      CLIENT_CONTEXT_MAX_BYTES,
    );
    expect(normalizeDiagnosticClientContext(bag)).toBeUndefined();
  });
});
