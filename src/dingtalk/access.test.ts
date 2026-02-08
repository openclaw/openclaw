import { describe, expect, it } from "vitest";
import { isSenderAllowed, normalizeAllowFrom } from "./access.js";

describe("isSenderAllowed", () => {
  it("returns true for wildcard", () => {
    const allow = normalizeAllowFrom(["*"]);
    expect(isSenderAllowed({ allow, senderId: "user1" })).toBe(true);
  });

  it("returns false when allowlist has no entries", () => {
    const allow = normalizeAllowFrom([]);
    expect(isSenderAllowed({ allow, senderId: "user1" })).toBe(false);
  });

  it("returns true for matching senderId", () => {
    const allow = normalizeAllowFrom(["user1", "user2"]);
    expect(isSenderAllowed({ allow, senderId: "user1" })).toBe(true);
  });

  it("returns true for case-insensitive match", () => {
    const allow = normalizeAllowFrom(["User1"]);
    expect(isSenderAllowed({ allow, senderId: "user1" })).toBe(true);
  });

  it("returns false for non-matching senderId", () => {
    const allow = normalizeAllowFrom(["user1"]);
    expect(isSenderAllowed({ allow, senderId: "user2" })).toBe(false);
  });

  it("returns false when senderId is undefined", () => {
    const allow = normalizeAllowFrom(["user1"]);
    expect(isSenderAllowed({ allow })).toBe(false);
  });
});
