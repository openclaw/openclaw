import { afterEach, describe, expect, it } from "vitest";
import {
  hasNodeErrorCode,
  isNodeError,
  isNotFoundPathError,
  isPathInside,
  isSymlinkOpenError,
  normalizeWindowsPathForComparison,
} from "./path-guards.js";

const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", {
    value: platform,
    configurable: true,
  });
}

afterEach(() => {
  if (originalPlatformDescriptor) {
    Object.defineProperty(process, "platform", originalPlatformDescriptor);
  }
});

describe("normalizeWindowsPathForComparison", () => {
  it("normalizes extended-length and UNC windows paths", () => {
    expect(normalizeWindowsPathForComparison("\\\\?\\C:\\Users\\Peter/Repo")).toBe(
      "c:\\users\\peter\\repo",
    );
    expect(normalizeWindowsPathForComparison("\\\\?\\UNC\\Server\\Share\\Folder")).toBe(
      "\\\\server\\share\\folder",
    );
  });
});

describe("node path error helpers", () => {
  it("recognizes node-style error objects and exact codes", () => {
    const enoent = { code: "ENOENT" };

    expect(isNodeError(enoent)).toBe(true);
    expect(isNodeError({ message: "nope" })).toBe(false);
    expect(hasNodeErrorCode(enoent, "ENOENT")).toBe(true);
    expect(hasNodeErrorCode(enoent, "EACCES")).toBe(false);
  });

  it("classifies not-found and symlink-open error codes", () => {
    expect(isNotFoundPathError({ code: "ENOENT" })).toBe(true);
    expect(isNotFoundPathError({ code: "ENOTDIR" })).toBe(true);
    expect(isNotFoundPathError({ code: "EACCES" })).toBe(false);

    expect(isSymlinkOpenError({ code: "ELOOP" })).toBe(true);
    expect(isSymlinkOpenError({ code: "EINVAL" })).toBe(true);
    expect(isSymlinkOpenError({ code: "ENOTSUP" })).toBe(true);
    expect(isSymlinkOpenError({ code: "ENOENT" })).toBe(false);
  });
});

describe("isPathInside", () => {
  it("accepts identical and nested paths but rejects escapes", () => {
    expect(isPathInside("/workspace/root", "/workspace/root")).toBe(true);
    expect(isPathInside("/workspace/root", "/workspace/root/nested/file.txt")).toBe(true);
    expect(isPathInside("/workspace/root", "/workspace/root/../escape.txt")).toBe(false);
  });

  it("uses win32 path semantics for windows containment checks", () => {
    setPlatform("win32");

    expect(isPathInside(String.raw`C:\workspace\root`, String.raw`C:\workspace\root`)).toBe(true);
    expect(
      isPathInside(String.raw`C:\workspace\root`, String.raw`C:\workspace\root\Nested\File.txt`),
    ).toBe(true);
    expect(
      isPathInside(String.raw`C:\workspace\root`, String.raw`C:\workspace\root\..\escape.txt`),
    ).toBe(false);
    expect(
      isPathInside(String.raw`C:\workspace\root`, String.raw`D:\workspace\root\file.txt`),
    ).toBe(false);
  });
});
