import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  findConflictMarkerLines,
  findConflictMarkersInFiles,
  listTrackedFiles,
} from "../../scripts/check-no-conflict-markers.mjs";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-conflict-markers-"));
  tempDirs.push(dir);
  return dir;
}

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
        ["Example:", "  <<<<<<< HEAD", "const text = '======= not a conflict';"].join("\n"),
      ),
    ).toEqual([]);
  });

  it("scans text files and skips binary files", () => {
    const rootDir = makeTempDir();
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

  it("finds conflict markers in tracked script files", () => {
    const rootDir = makeTempDir();
    git(rootDir, "init", "-q");
    git(rootDir, "config", "user.email", "test@example.com");
    git(rootDir, "config", "user.name", "Test User");

    const scriptFile = path.join(rootDir, "scripts", "generate-bundled-plugin-metadata.mjs");
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
    git(rootDir, "add", "scripts/generate-bundled-plugin-metadata.mjs");

    const violations = findConflictMarkersInFiles(listTrackedFiles(rootDir));

    expect(violations).toEqual([
      {
        filePath: scriptFile,
        lines: [1, 3, 5],
      },
    ]);
  });
});
