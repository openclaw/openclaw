// Covers the redaction recursion depth guard for deeply nested config objects.
// Extracted into a sibling module so redact-snapshot.test.ts (already at the
// grandfathered max-lines budget) does not grow; the guard itself lives in
// ./redact-snapshot.ts.
import { describe, expect, it } from "vitest";
import { redactConfigObject } from "./redact-snapshot.js";

describe("redactConfigObject depth guard", () => {
  it("rejects deeply nested config instead of overflowing the stack", () => {
    // redactValue() recurses through every nested value; beyond the internal
    // cap (100) this must throw a clear Error rather than
    // "RangeError: Maximum call stack size exceeded". 400 levels is well past it.
    let value: unknown = { leaf: "x" };
    for (let i = 0; i < 400; i += 1) {
      value = { x: value };
    }
    expect(() => redactConfigObject(value)).toThrow(/maximum nesting depth/i);
  });

  it("redacts config nested within the maximum depth", () => {
    let value: unknown = { apiKey: "secret-value" };
    for (let i = 0; i < 10; i += 1) {
      value = { x: value };
    }
    expect(() => redactConfigObject(value)).not.toThrow();
  });
});
