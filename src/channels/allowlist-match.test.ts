import { describe, expect, it } from "vitest";
import { normalizeAllowList, resolveAllowlistMatchSimple } from "./allowlist-match.js";

describe("normalizeAllowList", () => {
  it("returns empty array for undefined input", () => {
    expect(normalizeAllowList(undefined)).toEqual([]);
  });

  it("returns empty array for empty array", () => {
    expect(normalizeAllowList([])).toEqual([]);
  });

  it("trims whitespace from entries", () => {
    expect(normalizeAllowList(["  alice  ", " bob "])).toEqual(["alice", "bob"]);
  });

  it("filters out blank entries after trimming", () => {
    expect(normalizeAllowList(["alice", "  ", "", "bob"])).toEqual(["alice", "bob"]);
  });

  it("converts numbers to strings", () => {
    expect(normalizeAllowList([123, 456])).toEqual(["123", "456"]);
  });

  it("handles mixed string and number entries", () => {
    expect(normalizeAllowList(["alice", 123])).toEqual(["alice", "123"]);
  });
});

describe("resolveAllowlistMatchSimple", () => {
  it("returns not-allowed when allowFrom is empty", () => {
    const result = resolveAllowlistMatchSimple({ allowFrom: [], senderId: "alice" });
    expect(result.allowed).toBe(false);
  });

  it("allows wildcard *", () => {
    const result = resolveAllowlistMatchSimple({ allowFrom: ["*"], senderId: "anyone" });
    expect(result.allowed).toBe(true);
    expect(result.matchSource).toBe("wildcard");
    expect(result.matchKey).toBe("*");
  });

  it("allows by sender ID (case-insensitive)", () => {
    const result = resolveAllowlistMatchSimple({ allowFrom: ["ALICE"], senderId: "alice" });
    expect(result.allowed).toBe(true);
    expect(result.matchSource).toBe("id");
  });

  it("allows by sender name", () => {
    const result = resolveAllowlistMatchSimple({
      allowFrom: ["alice"],
      senderId: "user-001",
      senderName: "Alice",
    });
    expect(result.allowed).toBe(true);
    expect(result.matchSource).toBe("name");
  });

  it("denies when neither id nor name matches", () => {
    const result = resolveAllowlistMatchSimple({
      allowFrom: ["bob"],
      senderId: "alice",
      senderName: "Alice",
    });
    expect(result.allowed).toBe(false);
  });
});
