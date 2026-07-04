import { Buffer } from "node:buffer";
import { describe, expect, test } from "vitest";
import { truncateCloseReason } from "./close-reason.js";

describe("truncateCloseReason", () => {
  const multibyte = "\u{1f600}";

  test("returns the fallback for an empty reason", () => {
    expect(truncateCloseReason("")).toBe("invalid handshake");
  });

  test("keeps close reasons that are already within the byte limit", () => {
    expect(truncateCloseReason("invalid connect params")).toBe("invalid connect params");
  });

  test("keeps a complete multibyte character when it fits at the byte limit", () => {
    const reason = `${"x".repeat(116)}${multibyte} trailing text`;
    const truncated = truncateCloseReason(reason);

    expect(truncated).toBe(`${"x".repeat(116)}${multibyte}`);
    expect(Buffer.byteLength(truncated)).toBe(120);
  });

  test("backs up before a split multibyte character", () => {
    const reason = `${"x".repeat(118)}${multibyte} trailing text`;
    const truncated = truncateCloseReason(reason);

    expect(truncated).toBe("x".repeat(118));
    expect(Buffer.byteLength(truncated)).toBeLessThanOrEqual(120);
    expect(truncated).not.toContain("\uFFFD");
  });

  test("returns an empty reason when the byte limit cannot fit one character", () => {
    expect(truncateCloseReason(multibyte, 3)).toBe("");
  });
});
