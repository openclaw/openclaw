import { describe, expect, it } from "vitest";
import { normalizeSignalAccountInput, parseSignalAllowFromEntries } from "./signal.js";

describe("normalizeSignalAccountInput", () => {
  it("normalizes valid E.164 numbers", () => {
    expect(normalizeSignalAccountInput(" +1 (555) 555-0123 ")).toBe("+15555550123");
  });

  it("rejects invalid values", () => {
    expect(normalizeSignalAccountInput("abc")).toBeNull();
  });
});

describe("parseSignalAllowFromEntries", () => {
  it("parses e164, uuid and wildcard entries", () => {
    expect(
      parseSignalAllowFromEntries("+15555550123, uuid:123e4567-e89b-12d3-a456-426614174000, *"),
    ).toEqual({
      entries: ["+15555550123", "uuid:123e4567-e89b-12d3-a456-426614174000", "*"],
    });
  });

  it("normalizes bare uuid values", () => {
    expect(parseSignalAllowFromEntries("123e4567-e89b-12d3-a456-426614174000")).toEqual({
      entries: ["uuid:123e4567-e89b-12d3-a456-426614174000"],
    });
  });

  it("returns validation errors for invalid entries", () => {
    expect(parseSignalAllowFromEntries("uuid:")).toEqual({
      entries: [],
      error: "Invalid uuid entry",
    });
    expect(parseSignalAllowFromEntries("invalid")).toEqual({
      entries: [],
      error: "Invalid entry: invalid",
    });
  });
});
