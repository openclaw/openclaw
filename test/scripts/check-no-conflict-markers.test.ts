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

  it("finds conflict markers in files larger than the scan byte limit", () => {
    const rootDir = createTempDir("openclaw-conflict-markers-");
    const largeFile = path.join(rootDir, "large-generated.txt");

    // Use a small chunk size for fast tests; the production limit is 50 MiB.
    const maxScanBytes = 1024;
    const markerLine = ">>>>>>> branch";
    const filler = "a".repeat(maxScanBytes);
    // The marker starts one byte after the first chunk boundary so the second
    // chunk is required to detect it.
    fs.writeFileSync(largeFile, `${filler}\n${markerLine}\n`);

    const violations = findConflictMarkersInFiles([largeFile], fs.statSync, () => {}, maxScanBytes);

    expect(violations).toEqual([
      {
        filePath: largeFile,
        lines: [2],
      },
    ]);
  });

  it("finds conflict markers that cross a chunk boundary", () => {
    const rootDir = createTempDir("openclaw-conflict-markers-");
    const crossBoundaryFile = path.join(rootDir, "cross-boundary.txt");

    // Split "<<<<<<< HEAD" so the first seven characters end the first chunk
    // and the rest begins the second chunk.
    const maxScanBytes = 7;
    const content = "<<<<<<< HEAD\nleft\n=======\nright\n>>>>>>> branch\n";
    fs.writeFileSync(crossBoundaryFile, content);

    const violations = findConflictMarkersInFiles(
      [crossBoundaryFile],
      fs.statSync,
      () => {},
      maxScanBytes,
    );

    expect(violations).toEqual([
      {
        filePath: crossBoundaryFile,
        lines: [1, 3, 5],
      },
    ]);
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

  it("reports conflict markers in a large tracked file without reading it whole", () => {
    const rootDir = createTempDir("openclaw-conflict-markers-");
    git(rootDir, "init", "-q");
    git(rootDir, "config", "user.email", "test@example.com");
    git(rootDir, "config", "user.name", "Test User");

    const largeFile = path.join(rootDir, "big-file.txt");
    const fillerLine = "x".repeat(1024);
    const fillerLines = Array.from({ length: 1024 }, () => fillerLine);
    const markerLines = ["<<<<<<< HEAD", "left", "=======", "right", ">>>>>>> branch"];
    fs.writeFileSync(largeFile, [...fillerLines, ...markerLines].join("\n"));
    git(rootDir, "add", "big-file.txt");

    const violations = findConflictMarkersInTrackedFiles(rootDir);

    expect(violations).toEqual([
      {
        filePath: largeFile,
        lines: [1025, 1027, 1029],
      },
    ]);
  });
});
