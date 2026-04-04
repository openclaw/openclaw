import { describe, expect, it } from "vitest";
import {
  isWindowsDrivePath,
  normalizeArchiveEntryPath,
  validateArchiveEntryPath,
  stripArchivePath,
} from "./archive-path.js";

describe("isWindowsDrivePath", () => {
  it("detects Windows drive paths", () => {
    expect(isWindowsDrivePath("C:\\Users")).toBe(true);
    expect(isWindowsDrivePath("D:\\folder\\file")).toBe(true);
    expect(isWindowsDrivePath("c:\\windows")).toBe(true);
  });

  it("rejects Unix paths", () => {
    expect(isWindowsDrivePath("/home/user")).toBe(false);
    expect(isWindowsDrivePath("/var/log")).toBe(false);
  });
});

describe("normalizeArchiveEntryPath", () => {
  it("normalizes backslashes to forward slashes", () => {
    expect(normalizeArchiveEntryPath("folder\\file.txt")).toBe("folder/file.txt");
    expect(normalizeArchiveEntryPath("a\\b\\c")).toBe("a/b/c");
  });

  it("keeps forward slashes unchanged", () => {
    expect(normalizeArchiveEntryPath("folder/file.txt")).toBe("folder/file.txt");
  });
});

describe("validateArchiveEntryPath", () => {
  it("allows valid relative paths", () => {
    expect(() => validateArchiveEntryPath("file.txt")).not.toThrow();
    expect(() => validateArchiveEntryPath("folder/file.txt")).not.toThrow();
  });

  it("allows dot paths", () => {
    expect(() => validateArchiveEntryPath(".")).not.toThrow();
    expect(() => validateArchiveEntryPath("./")).not.toThrow();
  });

  it("throws for Windows drive paths", () => {
    expect(() => validateArchiveEntryPath("C:\\Users")).toThrow("drive path");
  });

  it("throws for absolute paths", () => {
    expect(() => validateArchiveEntryPath("/absolute/path")).toThrow("absolute");
  });
});

describe("stripArchivePath", () => {
  it("strips components correctly", () => {
    expect(stripArchivePath("a/b/c", 1)).toBe("b/c");
    expect(stripArchivePath("a/b/c", 2)).toBe("c");
  });

  it("returns null for empty after strip", () => {
    expect(stripArchivePath("a/b", 5)).toBeNull();
    expect(stripArchivePath("a", 1)).toBeNull();
  });

  it("handles dot segments", () => {
    expect(stripArchivePath("./a/b", 0)).toBe("a/b");
  });

  it("returns null for dot paths", () => {
    expect(stripArchivePath(".")).toBeNull();
    expect(stripArchivePath("./")).toBeNull();
  });
});
