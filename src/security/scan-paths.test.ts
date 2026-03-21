import { describe, expect, it } from "vitest";
import { extensionUsesSkippedScannerPath, isPathInside } from "./scan-paths.js";

describe("isPathInside", () => {
  it("returns true when candidate equals base", () => {
    expect(isPathInside("/foo/bar", "/foo/bar")).toBe(true);
  });

  it("returns true for direct child", () => {
    expect(isPathInside("/foo", "/foo/bar")).toBe(true);
  });

  it("returns true for deeply nested child", () => {
    expect(isPathInside("/foo", "/foo/bar/baz/qux")).toBe(true);
  });

  it("returns false for parent directory", () => {
    expect(isPathInside("/foo/bar", "/foo")).toBe(false);
  });

  it("returns false for sibling directory", () => {
    expect(isPathInside("/foo/bar", "/foo/baz")).toBe(false);
  });

  it("returns false for traversal escape", () => {
    expect(isPathInside("/foo/bar", "/foo/bar/../../etc/passwd")).toBe(false);
  });

  it("handles trailing slashes", () => {
    expect(isPathInside("/foo/bar/", "/foo/bar/baz")).toBe(true);
  });

  it("returns false for prefix-but-not-directory match", () => {
    // /foo/barbaz is not inside /foo/bar even though it shares a prefix
    expect(isPathInside("/foo/bar", "/foo/barbaz")).toBe(false);
  });
});

describe("extensionUsesSkippedScannerPath", () => {
  it("returns true for paths containing node_modules", () => {
    expect(extensionUsesSkippedScannerPath("foo/node_modules/bar")).toBe(true);
  });

  it("returns true for hidden directories", () => {
    expect(extensionUsesSkippedScannerPath("foo/.hidden/bar")).toBe(true);
    expect(extensionUsesSkippedScannerPath(".git/config")).toBe(true);
  });

  it("returns false for normal paths", () => {
    expect(extensionUsesSkippedScannerPath("src/security/scan-paths.ts")).toBe(false);
    expect(extensionUsesSkippedScannerPath("extensions/discord/index.ts")).toBe(false);
  });

  it("returns false for current/parent directory refs", () => {
    expect(extensionUsesSkippedScannerPath("./foo/bar")).toBe(false);
    expect(extensionUsesSkippedScannerPath("../foo/bar")).toBe(false);
  });
});
