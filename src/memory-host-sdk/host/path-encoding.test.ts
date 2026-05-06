import path from "node:path";
import { describe, expect, it } from "vitest";
import { encodeUserSegment, resolveUserMemoryDir } from "./path-encoding.js";

describe("encodeUserSegment (hash mode)", () => {
  it("returns a deterministic 32-char hex segment", () => {
    const a = encodeUserSegment("alice", "hash");
    const b = encodeUserSegment("alice", "hash");
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{32}$/);
  });

  it("produces different segments for different IDs", () => {
    expect(encodeUserSegment("alice", "hash")).not.toBe(encodeUserSegment("bob", "hash"));
  });

  it("safely encodes user IDs containing path separators", () => {
    const segment = encodeUserSegment("../../etc/passwd", "hash");
    expect(segment).not.toContain("/");
    expect(segment).not.toContain("\\");
    expect(segment).not.toContain("..");
    expect(segment).toMatch(/^[0-9a-f]{32}$/);
  });

  it("safely encodes empty / NUL / dot inputs in hash mode", () => {
    expect(encodeUserSegment("", "hash")).toMatch(/^[0-9a-f]{32}$/);
    expect(encodeUserSegment("\0", "hash")).toMatch(/^[0-9a-f]{32}$/);
    expect(encodeUserSegment(".", "hash")).toMatch(/^[0-9a-f]{32}$/);
    expect(encodeUserSegment("..", "hash")).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe("encodeUserSegment (whitelist mode)", () => {
  it("accepts safe alphanumeric IDs unchanged", () => {
    expect(encodeUserSegment("alice_42", "whitelist")).toBe("alice_42");
    expect(encodeUserSegment("a-b-c", "whitelist")).toBe("a-b-c");
  });

  it("rejects path traversal attempts in whitelist mode", () => {
    expect(() => encodeUserSegment("../etc", "whitelist")).toThrow();
    expect(() => encodeUserSegment("a/b", "whitelist")).toThrow();
    expect(() => encodeUserSegment("a\\b", "whitelist")).toThrow();
    expect(() => encodeUserSegment("a\0", "whitelist")).toThrow();
    expect(() => encodeUserSegment(".", "whitelist")).toThrow();
    expect(() => encodeUserSegment("..", "whitelist")).toThrow();
  });

  it("rejects empty IDs in whitelist mode", () => {
    expect(() => encodeUserSegment("", "whitelist")).toThrow();
  });

  it("rejects overly long IDs in whitelist mode", () => {
    expect(() => encodeUserSegment("a".repeat(65), "whitelist")).toThrow();
  });

  it("rejects unicode/non-ASCII identifiers in whitelist mode", () => {
    expect(() => encodeUserSegment("정근", "whitelist")).toThrow();
  });
});

describe("resolveUserMemoryDir", () => {
  const memoryRoot = path.resolve("/var/data/memory");

  it("returns a path inside memoryRoot for hash mode", () => {
    const dir = resolveUserMemoryDir(memoryRoot, "alice", "hash");
    expect(dir.startsWith(memoryRoot + path.sep)).toBe(true);
  });

  it("returns a path inside memoryRoot for whitelist mode", () => {
    const dir = resolveUserMemoryDir(memoryRoot, "alice", "whitelist");
    expect(dir).toBe(path.resolve(memoryRoot, "alice"));
  });

  it("rejects whitelist mode IDs that would escape root", () => {
    expect(() => resolveUserMemoryDir(memoryRoot, "../escape", "whitelist")).toThrow();
  });

  it("hash mode never escapes root, even for crafted inputs", () => {
    const crafted = "../../../../etc/passwd";
    const dir = resolveUserMemoryDir(memoryRoot, crafted, "hash");
    expect(dir.startsWith(memoryRoot + path.sep)).toBe(true);
  });
});
