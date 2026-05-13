import { describe, expect, it } from "vitest";
import { formatFilesystemTimestamp } from "./filesystem-timestamp.js";

describe("formatFilesystemTimestamp", () => {
  it("formats timestamps for filesystem-safe names", () => {
    const now = Date.parse("2026-02-23T12:34:56.000Z");
    expect(formatFilesystemTimestamp(now)).toBe("2026-02-23T12-34-56.000Z");
  });
});
