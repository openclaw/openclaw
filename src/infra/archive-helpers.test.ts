import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTrackedTempDirs } from "../test-utils/tracked-temp-dirs.js";
import {
  createTarEntryPreflightChecker,
  fileExists,
  readJsonFile,
  resolveArchiveKind,
  resolvePackedRootDir,
  withTimeout,
} from "./archive.js";

const tempDirs = createTrackedTempDirs();
const createTempDir = () => tempDirs.make("openclaw-archive-helper-test-");

afterEach(async () => {
  vi.useRealTimers();
  await tempDirs.cleanup();
});

describe("archive helpers", () => {
  it.each([
    { input: "/tmp/file.zip", expected: "zip" },
    { input: "/tmp/file.TAR.GZ", expected: "tar" },
    { input: "/tmp/file.tgz", expected: "tar" },
    { input: "/tmp/file.tar", expected: "tar" },
    { input: "/tmp/file.txt", expected: null },
  ])("detects archive kind for $input", ({ input, expected }) => {
    expect(resolveArchiveKind(input)).toBe(expected);
  });

  it("resolves packed roots from package dir or single extracted root dir", async () => {
    const directDir = await createTempDir();
    const fallbackDir = await createTempDir();
    const markerDir = await createTempDir();
    await fs.mkdir(path.join(directDir, "package"), { recursive: true });
    await fs.mkdir(path.join(fallbackDir, "bundle-root"), { recursive: true });
    await fs.writeFile(path.join(markerDir, "package.json"), "{}", "utf8");

    await expect(resolvePackedRootDir(directDir)).resolves.toBe(path.join(directDir, "package"));
    await expect(resolvePackedRootDir(fallbackDir)).resolves.toBe(
      path.join(fallbackDir, "bundle-root"),
    );
    await expect(resolvePackedRootDir(markerDir, { rootMarkers: ["package.json"] })).resolves.toBe(
      markerDir,
    );
  });

  it("rejects unexpected packed root layouts", async () => {
    const multipleDir = await createTempDir();
    const emptyDir = await createTempDir();
    await fs.mkdir(path.join(multipleDir, "a"), { recursive: true });
    await fs.mkdir(path.join(multipleDir, "b"), { recursive: true });
    await fs.writeFile(path.join(emptyDir, "note.txt"), "hi", "utf8");

    await expect(resolvePackedRootDir(multipleDir)).rejects.toThrow(/unexpected archive layout/i);
    await expect(resolvePackedRootDir(emptyDir)).rejects.toThrow(/unexpected archive layout/i);
  });

  it("returns work results and propagates errors before timeout", async () => {
    await expect(withTimeout(Promise.resolve("ok"), 100, "extract zip")).resolves.toBe("ok");
    await expect(
      withTimeout(Promise.reject(new Error("boom")), 100, "extract zip"),
    ).rejects.toThrow("boom");
  });

  it("rejects when archive work exceeds the timeout", async () => {
    vi.useFakeTimers();
    const late = new Promise<string>((resolve) => setTimeout(() => resolve("ok"), 50));
    const result = withTimeout(late, 1, "extract tar");
    const pending = expect(result).rejects.toThrow("extract tar timed out after 1ms");
    await vi.advanceTimersByTimeAsync(1);
    await pending;
  });

  it("preflights tar entries for blocked link types, path escapes, and size budgets", () => {
    const checker = createTarEntryPreflightChecker({
      rootDir: "/tmp/dest",
      limits: {
        maxEntries: 1,
        maxEntryBytes: 8,
        maxExtractedBytes: 12,
      },
    });

    expect(() => checker({ path: "package/link", type: "SymbolicLink", size: 0 })).toThrow(
      "tar entry is a link: package/link",
    );
    expect(() => checker({ path: "../escape.txt", type: "File", size: 1 })).toThrow(
      /escapes destination|absolute/i,
    );

    checker({ path: "package/ok.txt", type: "File", size: 8 });
    expect(() => checker({ path: "package/second.txt", type: "File", size: 1 })).toThrow(
      "archive entry count exceeds limit",
    );
  });

  it("treats stripped-away tar entries as no-ops and enforces extracted byte budgets", () => {
    const checker = createTarEntryPreflightChecker({
      rootDir: "/tmp/dest",
      stripComponents: 1,
      limits: {
        maxEntries: 4,
        maxEntryBytes: 16,
        maxExtractedBytes: 10,
      },
    });

    expect(() => checker({ path: "package", type: "Directory", size: 0 })).not.toThrow();
    checker({ path: "package/a.txt", type: "File", size: 6 });
    expect(() => checker({ path: "package/b.txt", type: "File", size: 6 })).toThrow(
      "archive extracted size exceeds limit",
    );
  });

  it("reads JSON files and reports file existence", async () => {
    const dir = await createTempDir();
    const jsonPath = path.join(dir, "data.json");
    const badPath = path.join(dir, "bad.json");
    await fs.writeFile(jsonPath, '{"ok":true}', "utf8");
    await fs.writeFile(badPath, "{not json", "utf8");

    await expect(readJsonFile<{ ok: boolean }>(jsonPath)).resolves.toEqual({ ok: true });
    await expect(readJsonFile(badPath)).rejects.toThrow();
    await expect(fileExists(jsonPath)).resolves.toBe(true);
    await expect(fileExists(path.join(dir, "missing.json"))).resolves.toBe(false);
  });
});
