import { describe, expect, it } from "vitest";
import { canonicalizeBase64, estimateBase64DecodedBytes } from "./base64.js";

describe("base64 helpers", () => {
  it("normalizes whitespace and keeps valid base64", () => {
    const input = " SGV s bG8= \n";
    expect(canonicalizeBase64(input)).toBe("SGVsbG8=");
  });

  it("rejects invalid base64 characters", () => {
    const input = 'SGVsbG8=" onerror="alert(1)';
    expect(canonicalizeBase64(input)).toBeUndefined();
  });

  it("estimates decoded bytes with whitespace", () => {
    expect(estimateBase64DecodedBytes("SGV s bG8= \n")).toBe(5);
  });
});
