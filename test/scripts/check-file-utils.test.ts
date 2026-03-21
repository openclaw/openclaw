import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { collectFilesSync, isCodeFile, relativeToCwd } from "../../scripts/check-file-utils.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-check-file-utils-"));
  tempDirs.push(dir);
  return dir;
}

describe("scripts/check-file-utils isCodeFile", () => {
  it("accepts source files and skips declarations", () => {
    expect(isCodeFile("example.ts")).toBe(true);
    expect(isCodeFile("example.mjs")).toBe(true);
    expect(isCodeFile("example.d.ts")).toBe(false);
  });
});

describe("scripts/check-file-utils collectFilesSync", () => {
  it("collects matching files while skipping common generated dirs", () => {
    const rootDir = makeTempDir();
    fs.mkdirSync(path.join(rootDir, "src", "nested"), { recursive: true });
    fs.mkdirSync(path.join(rootDir, "dist"), { recursive: true });
    fs.writeFileSync(path.join(rootDir, "src", "keep.ts"), "");
    fs.writeFileSync(path.join(rootDir, "src", "nested", "keep.test.ts"), "");
    fs.writeFileSync(path.join(rootDir, "dist", "skip.ts"), "");

    const files = collectFilesSync(rootDir, {
      includeFile: (filePath) => filePath.endsWith(".ts"),
    }).map((filePath) => path.relative(rootDir, filePath));

    expect(files.toSorted()).toEqual(["src/keep.ts", "src/nested/keep.test.ts"]);
  });

  it("supports custom skipped directories", () => {
    const rootDir = makeTempDir();
    fs.mkdirSync(path.join(rootDir, "fixtures"), { recursive: true });
    fs.mkdirSync(path.join(rootDir, "src"), { recursive: true });
    fs.writeFileSync(path.join(rootDir, "fixtures", "skip.ts"), "");
    fs.writeFileSync(path.join(rootDir, "src", "keep.ts"), "");

    const files = collectFilesSync(rootDir, {
      includeFile: (filePath) => filePath.endsWith(".ts"),
      skipDirNames: new Set(["fixtures"]),
    }).map((filePath) => path.relative(rootDir, filePath));

    expect(files).toEqual(["src/keep.ts"]);
  });
});

describe("scripts/check-file-utils relativeToCwd", () => {
  it("renders repo-relative paths when possible", () => {
    expect(relativeToCwd(path.join(process.cwd(), "scripts", "check-file-utils.ts"))).toBe(
      "scripts/check-file-utils.ts",
    );
  });
});
