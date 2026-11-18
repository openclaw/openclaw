import { describe, expect, it } from "vitest";
import { truncateCloseReason } from "./close-reason.js";

describe("truncateCloseReason", () => {
  it("returns the reason unchanged when it fits within the byte cap", () => {
    expect(truncateCloseReason("short reason")).toBe("short reason");
  });

  it("returns 'invalid handshake' for empty string", () => {
    expect(truncateCloseReason("")).toBe("invalid handshake");
  });

  it("truncates ASCII-only reasons at exactly maxBytes", () => {
    const reason = "a".repeat(200);
    const result = truncateCloseReason(reason);
    expect(Buffer.byteLength(result)).toBe(120);
    expect(result).toBe("a".repeat(120));
  });

  it("does not split a UTF-8 code point at the byte cap", () => {
    const reason = "a" + "😀".repeat(40);
    const result = truncateCloseReason(reason);
    expect(Buffer.byteLength(result)).toBeLessThanOrEqual(120);
    expect(result).not.toContain("�");
    expect(result).toBe("a" + "😀".repeat(29));
  });
});
