import { describe, it, expect } from "vitest";
import { isValidBase64 } from "./chat-attachments.js";

describe("isValidBase64 — production function", () => {
  it("accepts valid padded base64", () => {
    expect(isValidBase64("dGVzdA==")).toBe(true);
    expect(
      isValidBase64(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
      ),
    ).toBe(true);
  });

  it("rejects empty string", () => {
    expect(isValidBase64("")).toBe(false);
  });

  it("rejects string with invalid characters", () => {
    expect(isValidBase64("invalid!")).toBe(false);
  });

  it("rejects unpadded base64 (length not divisible by 4)", () => {
    expect(isValidBase64("abc")).toBe(false);
  });

  it("rejects strings with padding in middle", () => {
    expect(isValidBase64("abc=defg")).toBe(false);
  });

  it("rejects strings with too much padding", () => {
    expect(isValidBase64("a===")).toBe(false);
  });
});
