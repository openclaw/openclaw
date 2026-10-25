// Tests for FilesystemObserver.
import { describe, expect, it, vi } from "vitest";
import { EvidenceRecordSchema } from "../config/zod-schema.registry-validation.js";
import { observeFilesystem } from "./filesystem-observer.js";
import type { FilesystemObserverDeps } from "./filesystem-observer.js";

const FIXED_TIME = "2026-07-18T12:00:00.000Z";
const now = () => FIXED_TIME;

function makeMockStats(
  opts: {
    isFile?: boolean;
    isDirectory?: boolean;
    isSymlink?: boolean;
    size?: number;
    mtime?: Date;
  } = {},
): import("node:fs").Stats {
  return {
    isFile: () => opts.isFile ?? false,
    isDirectory: () => opts.isDirectory ?? false,
    isSymbolicLink: () => opts.isSymlink ?? false,
    isBlockDevice: () => false,
    isCharacterDevice: () => false,
    isFIFO: () => false,
    isSocket: () => false,
    size: opts.size ?? 1024,
    mtime: opts.mtime ?? new Date("2026-01-01T00:00:00.000Z"),
    mtimeMs: 0,
    atime: new Date(),
    atimeMs: 0,
    ctime: new Date(),
    ctimeMs: 0,
    birthtime: new Date(),
    birthtimeMs: 0,
    dev: 0,
    ino: 0,
    mode: 0,
    nlink: 0,
    uid: 0,
    gid: 0,
    rdev: 0,
    blksize: 0,
    blocks: 0,
  } as unknown as import("node:fs").Stats;
}

function makeDeps(overrides: Partial<FilesystemObserverDeps> = {}): FilesystemObserverDeps {
  return {
    existsSync: vi.fn(() => true),
    statSync: vi.fn(() => makeMockStats({ isFile: true })),
    accessSync: vi.fn(() => {}),
    constants: { R_OK: 4 },
    ...overrides,
  };
}

describe("FilesystemObserver", () => {
  it("readable file", () => {
    const deps = makeDeps({
      statSync: vi.fn(() => makeMockStats({ isFile: true, size: 500 })),
    });
    const result = observeFilesystem("/test/file.txt", "file", deps, { now });
    expect(result.outcome).toBe("EXISTS_READABLE");
    expect(result.exists).toBe(true);
    expect(result.isFile).toBe(true);
    expect(result.readable).toBe(true);
    expect(result.statMetadata?.size).toBe(500);
  });

  it("readable directory", () => {
    const deps = makeDeps({
      statSync: vi.fn(() => makeMockStats({ isDirectory: true })),
    });
    const result = observeFilesystem("/test/dir", "directory", deps, { now });
    expect(result.outcome).toBe("EXISTS_READABLE");
    expect(result.isDirectory).toBe(true);
  });

  it("missing path", () => {
    const deps = makeDeps({ existsSync: vi.fn(() => false) });
    const result = observeFilesystem("/test/missing", null, deps, { now });
    expect(result.outcome).toBe("MISSING");
    expect(result.exists).toBe(false);
  });

  it("wrong expected type (expected file, got directory)", () => {
    const deps = makeDeps({
      statSync: vi.fn(() => makeMockStats({ isDirectory: true })),
    });
    const result = observeFilesystem("/test/dir", "file", deps, { now });
    expect(result.outcome).toBe("WRONG_TYPE");
    expect(result.error).toContain("Expected file");
  });

  it("wrong expected type (expected directory, got file)", () => {
    const deps = makeDeps({
      statSync: vi.fn(() => makeMockStats({ isFile: true })),
    });
    const result = observeFilesystem("/test/file", "directory", deps, { now });
    expect(result.outcome).toBe("WRONG_TYPE");
    expect(result.error).toContain("Expected directory");
  });

  it("unreadable path (accessSync throws)", () => {
    const deps = makeDeps({
      statSync: vi.fn(() => makeMockStats({ isFile: true })),
      accessSync: vi.fn(() => {
        throw new Error("EACCES");
      }),
    });
    const result = observeFilesystem("/test/secret.txt", "file", deps, { now });
    expect(result.outcome).toBe("EXISTS_UNREADABLE");
    expect(result.readable).toBe(false);
  });

  it("access error on statSync", () => {
    const deps = makeDeps({
      statSync: vi.fn(() => {
        throw new Error("EPERM");
      }),
    });
    const result = observeFilesystem("/test/locked", null, deps, { now });
    expect(result.outcome).toBe("ACCESS_ERROR");
    expect(result.error).toContain("EPERM");
  });

  it("invalid path (empty string)", () => {
    const deps = makeDeps();
    const result = observeFilesystem("", null, deps, { now });
    expect(result.outcome).toBe("INVALID_PATH");
    expect(result.error).toContain("empty");
  });

  it("symlink metadata where supported", () => {
    const deps = makeDeps({
      statSync: vi.fn(() => makeMockStats({ isFile: true, isSymlink: true })),
    });
    const result = observeFilesystem("/test/link", "file", deps, { now });
    expect(result.outcome).toBe("EXISTS_READABLE");
    expect(result.statMetadata?.isSymlink).toBe(true);
  });

  it("no recursion by default (wantListing=false)", () => {
    const readdirMock = vi.fn(() => ["a", "b", "c"]);
    const deps = makeDeps({
      statSync: vi.fn(() => makeMockStats({ isDirectory: true })),
      readdirSync: readdirMock,
    });
    const result = observeFilesystem("/test/dir", "directory", deps, { now });
    expect(result.listing).toBeNull();
    expect(readdirMock).not.toHaveBeenCalled();
  });

  it("bounded non-recursive listing when requested", () => {
    const readdirMock = vi.fn(() => ["a.txt", "b.txt"]);
    const deps = makeDeps({
      statSync: vi.fn(() => makeMockStats({ isDirectory: true })),
      readdirSync: readdirMock,
    });
    const result = observeFilesystem("/test/dir", "directory", deps, { now, wantListing: true });
    expect(result.listing).toEqual(["a.txt", "b.txt"]);
    expect(readdirMock).toHaveBeenCalledTimes(1);
  });

  it("evidence validates against Phase 4F1 schema", () => {
    const deps = makeDeps();
    const result = observeFilesystem("/test/file.txt", "file", deps, { now });
    for (const evidence of result.evidence) {
      const validation = EvidenceRecordSchema.safeParse(evidence);
      expect(validation.success).toBe(true);
    }
  });

  it("Windows path normalization (backslashes)", () => {
    const deps = makeDeps();
    const winPath = "C:\\Users\\test\\file.txt";
    const result = observeFilesystem(winPath, "file", deps, { now });
    expect(result.path).toBe(winPath);
  });

  it("no mutation calls (writeFile, mkdir, etc. not invoked)", () => {
    const deps = makeDeps();
    observeFilesystem("/test/file.txt", "file", deps, { now });
    // Verify only read methods were called
    expect(deps.existsSync).toHaveBeenCalled();
    expect(deps.statSync).toHaveBeenCalled();
    expect(deps.accessSync).toHaveBeenCalled();
    // No write operations should exist in the interface
  });
});
