import { describe, expect, it } from "vitest";
import { canonicalizePolicyJson } from "./policy.canonical.js";

describe("canonicalizePolicyJson", () => {
  it("normalizes keys deterministically", () => {
    expect(canonicalizePolicyJson({ b: 2, a: 1 })).toBe('{"a":1,"b":2}');
  });

  it("rejects undefined top-level values", () => {
    expect(() => canonicalizePolicyJson(undefined)).toThrow(
      "Policy JSON contains an unsupported value type.",
    );
  });

  it("rejects nested undefined values", () => {
    expect(() => canonicalizePolicyJson({ tools: { allow: undefined } })).toThrow(
      "Policy JSON contains an unsupported value type.",
    );
  });
});
