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

  it("respects a custom maxBytes cap", () => {
    const reason = "😀".repeat(10); // each 4 bytes = 40 bytes
    const result = truncateCloseReason(reason, 10);
    expect(Buffer.byteLength(result)).toBeLessThanOrEqual(10);
    expect(result).not.toContain("�");
    expect(result).toBe("😀".repeat(2)); // 8 bytes, next emoji would exceed 10
  });
});
