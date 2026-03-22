import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  findConflictMarkerLines,
  findConflictMarkersInFiles,
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
});
