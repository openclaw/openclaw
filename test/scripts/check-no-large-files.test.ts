import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_MAX_BYTES, findLargeFiles } from "../../scripts/check-no-large-files.mjs";
import { createScriptTestHarness } from "./test-helpers.js";

const { createTempDir } = createScriptTestHarness();

function makeFile(dir: string, relativePath: string, bytes: number): void {
  const absolutePath = path.join(dir, relativePath);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  // Writing zeros keeps the test deterministic and cheap.
  fs.writeFileSync(absolutePath, Buffer.alloc(bytes, 0));
}

function makeFiles(dir: string, entries: ReadonlyArray<{ relativePath: string; bytes: number }>) {
  for (const entry of entries) {
    makeFile(dir, entry.relativePath, entry.bytes);
  }
  return entries.map((entry) => ({
    relativePath: entry.relativePath,
    absolutePath: path.join(dir, entry.relativePath),
  }));
}

describe("check-no-large-files", () => {
  it("returns no offenders when every file is under the threshold", () => {
    const dir = createTempDir("openclaw-large-files-");
    const files = makeFiles(dir, [
      { relativePath: "a.bin", bytes: 1024 },
      { relativePath: "nested/b.bin", bytes: 2048 },
    ]);
    expect(findLargeFiles(files, { maxBytes: 4096, allowlist: new Set() })).toEqual([]);
  });

  it("flags files that exceed the threshold and sorts by size descending", () => {
    const dir = createTempDir("openclaw-large-files-");
    const files = makeFiles(dir, [
      { relativePath: "small.bin", bytes: 100 },
      { relativePath: "big.bin", bytes: 5000 },
      { relativePath: "bigger.bin", bytes: 9000 },
    ]);
    const offenders = findLargeFiles(files, { maxBytes: 500, allowlist: new Set() });
    expect(offenders).toEqual([
      { relativePath: "bigger.bin", bytes: 9000 },
      { relativePath: "big.bin", bytes: 5000 },
    ]);
  });

  it("skips allowlisted paths even when they are oversize", () => {
    const dir = createTempDir("openclaw-large-files-");
    const files = makeFiles(dir, [
      { relativePath: "dist/vendor.js", bytes: 10_000 },
      { relativePath: "src/app.ts", bytes: 10_000 },
    ]);
    const offenders = findLargeFiles(files, {
      maxBytes: 1000,
      allowlist: new Set(["dist/vendor.js"]),
    });
    expect(offenders).toEqual([{ relativePath: "src/app.ts", bytes: 10_000 }]);
  });

  it("tolerates files that were removed between the listing and the stat", () => {
    const dir = createTempDir("openclaw-large-files-");
    makeFile(dir, "present.bin", 10_000);
    const files = [
      { relativePath: "present.bin", absolutePath: path.join(dir, "present.bin") },
      { relativePath: "ghost.bin", absolutePath: path.join(dir, "ghost.bin") },
    ];
    const offenders = findLargeFiles(files, { maxBytes: 1000, allowlist: new Set() });
    expect(offenders).toEqual([{ relativePath: "present.bin", bytes: 10_000 }]);
  });

  it("exposes a 3 MiB default threshold", () => {
    expect(DEFAULT_MAX_BYTES).toBe(3 * 1024 * 1024);
  });
});
