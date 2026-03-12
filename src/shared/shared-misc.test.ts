import { describe, expect, it, test } from "vitest";
import { extractTextFromChatContent } from "./chat-content.js";
import {
  getFrontmatterString,
  normalizeStringList,
  parseFrontmatterBool,
  resolveOpenClawManifestBlock,
} from "./frontmatter.js";
import { resolveNodeIdFromCandidates } from "./node-match.js";

describe("extractTextFromChatContent", () => {
  it("normalizes string content", () => {
    expect(extractTextFromChatContent("  hello\nworld  ")).toBe("hello world");
  });

  it("extracts text blocks from array content", () => {
    expect(
      extractTextFromChatContent([
        { type: "text", text: " hello " },
        { type: "image_url", image_url: "https://example.com" },
        { type: "text", text: "world" },
      ]),
    ).toBe("hello world");
  });

  it("applies sanitizer when provided", () => {
    expect(
      extractTextFromChatContent("Here [Tool Call: foo (ID: 1)] ok", {
        sanitizeText: (text) => text.replace(/\[Tool Call:[^\]]+\]\s*/g, ""),
      }),
    ).toBe("Here ok");
  });

  it("supports custom join and normalization", () => {
    expect(
      extractTextFromChatContent(
        [
          { type: "text", text: " hello " },
          { type: "text", text: "world " },
        ],
        {
          sanitizeText: (text) => text.trim(),
          joinWith: "\n",
          normalizeText: (text) => text.trim(),
        },
      ),
    ).toBe("hello\nworld");
  });
});

describe("shared/frontmatter", () => {
  test("normalizeStringList handles strings and arrays", () => {
    expect(normalizeStringList("a, b,,c")).toEqual(["a", "b", "c"]);
    expect(normalizeStringList([" a ", "", "b"])).toEqual(["a", "b"]);
    expect(normalizeStringList(null)).toEqual([]);
  });

  test("getFrontmatterString extracts strings only", () => {
    expect(getFrontmatterString({ a: "b" }, "a")).toBe("b");
    expect(getFrontmatterString({ a: 1 }, "a")).toBeUndefined();
  });

  test("parseFrontmatterBool respects fallback", () => {
    expect(parseFrontmatterBool("true", false)).toBe(true);
    expect(parseFrontmatterBool("false", true)).toBe(false);
    expect(parseFrontmatterBool(undefined, true)).toBe(true);
  });

  test("resolveOpenClawManifestBlock parses JSON5 metadata and picks openclaw block", () => {
    const frontmatter = {
      metadata: "{ openclaw: { foo: 1, bar: 'baz' } }",
    };
    expect(resolveOpenClawManifestBlock({ frontmatter })).toEqual({ foo: 1, bar: "baz" });
  });

  test("resolveOpenClawManifestBlock returns undefined for invalid input", () => {
    expect(resolveOpenClawManifestBlock({ frontmatter: {} })).toBeUndefined();
    expect(
      resolveOpenClawManifestBlock({ frontmatter: { metadata: "not-json5" } }),
    ).toBeUndefined();
    expect(
      resolveOpenClawManifestBlock({ frontmatter: { metadata: "{ nope: { a: 1 } }" } }),
    ).toBeUndefined();
  });
});

describe("resolveNodeIdFromCandidates", () => {
  it("matches nodeId", () => {
    expect(
      resolveNodeIdFromCandidates(
        [
          { nodeId: "mac-123", displayName: "Mac Studio", remoteIp: "100.0.0.1" },
          { nodeId: "pi-456", displayName: "Raspberry Pi", remoteIp: "100.0.0.2" },
        ],
        "pi-456",
      ),
    ).toBe("pi-456");
  });

  it("matches displayName using normalization", () => {
    expect(
      resolveNodeIdFromCandidates([{ nodeId: "mac-123", displayName: "Mac Studio" }], "mac studio"),
    ).toBe("mac-123");
  });

  it("matches nodeId prefix (>=6 chars)", () => {
    expect(resolveNodeIdFromCandidates([{ nodeId: "mac-abcdef" }], "mac-ab")).toBe("mac-abcdef");
  });

  it("throws unknown node with known list", () => {
    expect(() =>
      resolveNodeIdFromCandidates(
        [
          { nodeId: "mac-123", displayName: "Mac Studio", remoteIp: "100.0.0.1" },
          { nodeId: "pi-456" },
        ],
        "nope",
      ),
    ).toThrow(/unknown node: nope.*known: /);
  });

  it("throws ambiguous node with matches list", () => {
    expect(() =>
      resolveNodeIdFromCandidates([{ nodeId: "mac-abcdef" }, { nodeId: "mac-abc999" }], "mac-abc"),
    ).toThrow(/ambiguous node: mac-abc.*matches:/);
  });

  it("prefers a unique connected node when names are duplicated", () => {
    expect(
      resolveNodeIdFromCandidates(
        [
          { nodeId: "ios-old", displayName: "iPhone", connected: false },
          { nodeId: "ios-live", displayName: "iPhone", connected: true },
        ],
        "iphone",
      ),
    ).toBe("ios-live");
  });

  it("stays ambiguous when multiple connected nodes match", () => {
    expect(() =>
      resolveNodeIdFromCandidates(
        [
          { nodeId: "ios-a", displayName: "iPhone", connected: true },
          { nodeId: "ios-b", displayName: "iPhone", connected: true },
        ],
        "iphone",
      ),
    ).toThrow(/ambiguous node: iphone.*matches:/);
  });
});
