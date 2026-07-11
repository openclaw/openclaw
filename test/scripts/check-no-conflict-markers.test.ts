// Check No Conflict Markers tests cover check no conflict markers script behavior.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  findConflictMarkerLines,
  findConflictMarkersInFiles,
  findConflictMarkersInTrackedFiles,
  listTrackedFiles,
} from "../../scripts/check-no-conflict-markers.mjs";
import { createScriptTestHarness } from "./test-helpers.js";

const { createTempDir } = createScriptTestHarness();

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
  }).trim();
}

describe("check-no-conflict-markers", () => {
  it("finds git conflict markers at the start of lines", () => {
    expect(
      findConflictMarkerLines(
        [
          "const ok = true;",
          "<<<<<<< HEAD",
          "value = left;",
          "=======",
          "value = right;",
          ">>>>>>> main",
        ].join("\n"),
      ),
    ).toEqual([2, 4, 6]);
  });

  it("ignores marker-like text when it is indented or inline", () => {
    expect(
      findConflictMarkerLines(
        ["Example:", "  <<<<<<< HEAD", "const text = '======= not a conflict';", "========"].join(
          "\n",
        ),
      ),
    ).toStrictEqual([]);
  });

  it("scans text files and skips binary files", () => {
    const rootDir = createTempDir("openclaw-conflict-markers-");
    const textFile = path.join(rootDir, "CHANGELOG.md");
    const binaryFile = path.join(rootDir, "image.png");
    fs.writeFileSync(textFile, "<<<<<<< HEAD\nconflict\n>>>>>>> main\n");
    fs.writeFileSync(binaryFile, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00]));

    const violations = findConflictMarkersInFiles([textFile, binaryFile]);

    expect(violations).toEqual([
      {
        filePath: textFile,
        lines: [1, 3],
      },
    ]);
  });

  it("skips files larger than the scan byte limit", () => {
    const rootDir = createTempDir("openclaw-conflict-markers-");
    const largeFile = path.join(rootDir, "large-generated.txt");
    const smallFile = path.join(rootDir, "conflict.txt");

    // Use a small limit for fast tests; the production limit is 50 MiB.
    const maxScanBytes = 1024;

    fs.writeFileSync(largeFile, "a".repeat(maxScanBytes + 1));
    fs.writeFileSync(smallFile, "<<<<<<< HEAD\nconflict\n>>>>>>> main\n");

    const warnings: string[] = [];
    const violations = findConflictMarkersInFiles(
      [largeFile, smallFile],
      fs.readFileSync,
      fs.statSync,
      (msg) => warnings.push(String(msg)),
      maxScanBytes,
    );

    expect(violations).toEqual([
      {
        filePath: smallFile,
        lines: [1, 3],
      },
    ]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("skipping oversized file");
    expect(warnings[0]).toContain(largeFile);
  });

  it("finds conflict markers in tracked script files", () => {
    const rootDir = createTempDir("openclaw-conflict-markers-");
    git(rootDir, "init", "-q");
    git(rootDir, "config", "user.email", "test@example.com");
    git(rootDir, "config", "user.name", "Test User");

    const scriptFile = path.join(rootDir, "scripts", "bundled-plugin-metadata-runtime.mjs");
    fs.mkdirSync(path.dirname(scriptFile), { recursive: true });
    fs.writeFileSync(
      scriptFile,
      [
        "<<<<<<< HEAD",
        'const left = "left";',
        "=======",
        'const right = "right";',
        ">>>>>>> branch",
      ].join("\n"),
    );
    git(rootDir, "add", "scripts/bundled-plugin-metadata-runtime.mjs");

    expect(findConflictMarkersInFiles(listTrackedFiles(rootDir))).toEqual([
      {
        filePath: scriptFile,
        lines: [1, 3, 5],
      },
    ]);

    const violations = findConflictMarkersInTrackedFiles(rootDir);

    expect(violations).toEqual([
      {
        filePath: scriptFile,
        lines: [1, 3, 5],
      },
    ]);
  });
});
