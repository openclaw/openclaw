import { describe, expect, it } from "vitest";
import {
  compileAllowlist,
  formatAllowlistMatchMeta,
  resolveAllowlistCandidates,
  resolveCompiledAllowlistMatch,
  resolveAllowlistMatchSimple,
} from "./allowlist-match.js";

describe("compileAllowlist", () => {
  it("creates set from entries", () => {
    const result = compileAllowlist(["user1", "user2"]);
    expect(result.set.size).toBe(2);
    expect(result.set.has("user1")).toBe(true);
    expect(result.set.has("user2")).toBe(true);
  });

  it("detects wildcard", () => {
    const result = compileAllowlist(["*", "user1"]);
    expect(result.wildcard).toBe(true);
  });

  it("filters empty entries", () => {
    const result = compileAllowlist(["user1", "", "user2"]);
    expect(result.set.size).toBe(2);
  });
});

describe("formatAllowlistMatchMeta", () => {
  it("formats match metadata", () => {
    const result = formatAllowlistMatchMeta({ matchKey: "user1", matchSource: "id" });
    expect(result).toContain("user1");
    expect(result).toContain("id");
  });

  it("handles null/undefined", () => {
    expect(formatAllowlistMatchMeta(null)).toContain("none");
    expect(formatAllowlistMatchMeta(undefined)).toContain("none");
  });
});

describe("resolveAllowlistCandidates", () => {
  it("returns allowed when match found", () => {
    const compiled = compileAllowlist(["user1", "user2"]);
    const result = resolveAllowlistCandidates({
      compiledAllowlist: compiled,
      candidates: [{ value: "user1", source: "id" }],
    });
    expect(result.allowed).toBe(true);
    expect(result.matchKey).toBe("user1");
  });

  it("returns not allowed when no match", () => {
    const compiled = compileAllowlist(["user1"]);
    const result = resolveAllowlistCandidates({
      compiledAllowlist: compiled,
      candidates: [{ value: "user2", source: "id" }],
    });
    expect(result.allowed).toBe(false);
  });

  it("skips empty values", () => {
    const compiled = compileAllowlist([]);
    const result = resolveAllowlistCandidates({
      compiledAllowlist: compiled,
      candidates: [{ value: "", source: "id" }],
    });
    expect(result.allowed).toBe(false);
  });
});

describe("resolveCompiledAllowlistMatch", () => {
  it("returns wildcard match", () => {
    const compiled = compileAllowlist(["*"]);
    const result = resolveCompiledAllowlistMatch({
      compiledAllowlist: compiled,
      candidates: [{ value: "anything", source: "id" }],
    });
    expect(result.allowed).toBe(true);
    expect(result.matchKey).toBe("*");
  });

  it("returns not allowed for empty set", () => {
    const compiled = compileAllowlist([]);
    const result = resolveCompiledAllowlistMatch({
      compiledAllowlist: compiled,
      candidates: [{ value: "user1", source: "id" }],
    });
    expect(result.allowed).toBe(false);
  });
});

describe("resolveAllowlistMatchSimple", () => {
  it("matches by sender ID", () => {
    const result = resolveAllowlistMatchSimple({
      allowFrom: ["user1", "user2"],
      senderId: "user1",
    });
    expect(result.allowed).toBe(true);
  });

  it("matches by sender name when allowed", () => {
    const result = resolveAllowlistMatchSimple({
      allowFrom: ["john"],
      senderId: "user123",
      senderName: "John",
      allowNameMatching: true,
    });
    expect(result.allowed).toBe(true);
    expect(result.matchSource).toBe("name");
  });

  it("returns not allowed when no match", () => {
    const result = resolveAllowlistMatchSimple({
      allowFrom: ["user1"],
      senderId: "user2",
    });
    expect(result.allowed).toBe(false);
  });
});
