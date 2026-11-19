import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { findConflictMarkersInTrackedFiles } from "../../scripts/check-no-conflict-markers.mjs";
import { createScriptTestHarness } from "./test-helpers.js";

const { createTempDir } = createScriptTestHarness();
const conflict = "<<<<<<< HEAD\nleft\n=======\nright\n>>>>>>> branch\n";
function scan(files: Record<string, string | Buffer>) {
  return findConflictMarkersInTrackedFiles(createRepository(files));
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function createRepository(files: Record<string, string | Buffer>): string {
  const rootDir = createTempDir("openclaw-conflict-markers-");
  git(rootDir, "init", "-q");
  for (const [file, content] of Object.entries(files)) {
    const filePath = path.join(rootDir, file);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content);
  }
  // The scanner reads indexed worktree files, so no commit or author setup is needed.
  git(rootDir, "add", "--", ...Object.keys(files));
  return rootDir;
}

it("reports exact lines across tracked text files and unusual paths", () => {
  const surrounded = "before\n" + conflict + "after\n";
  expect(
    scan({
      "src/conflict.ts": surrounded,
      "CHANGELOG.md": "<<<<<<< HEAD\nconflict\n>>>>>>> main\n",
      "scripts/bundled-plugin-metadata-runtime.mjs": conflict,
      "docs/new\nline.md": surrounded,
      "docs/weird name (v2).md": surrounded,
    }),
  ).toEqual([
    { filePath: "CHANGELOG.md", lines: [1, 3] },
    { filePath: "docs/new\nline.md", lines: [2, 4, 6] },
    { filePath: "docs/weird name (v2).md", lines: [2, 4, 6] },
    { filePath: "scripts/bundled-plugin-metadata-runtime.mjs", lines: [1, 3, 5] },
    { filePath: "src/conflict.ts", lines: [2, 4, 6] },
  ]);
});

it("ignores clean text, inline or indented markers, and binary marker bytes", () => {
  expect(
    scan({
      "src/clean.ts": "const x = 1;\n",
      "docs/examples.md":
        "Example:\n  <<<<<<< HEAD\nconst text = '======= not a conflict';\n========",
      // An actual marker prefix followed by NUL must still be excluded by git grep -I.
      "assets/image.png": Buffer.from("<<<<<<< HEAD\n\0"),
    }),
  ).toEqual([]);
});

it("disables configured git grep colors before parsing records", () => {
  const rootDir = createRepository({ "src/conflict.ts": conflict });
  git(rootDir, "config", "color.grep", "always");
  git(rootDir, "config", "color.grep.lineNumber", "red");

  expect(findConflictMarkersInTrackedFiles(rootDir)).toEqual([
    { filePath: "src/conflict.ts", lines: [1, 3, 5] },
  ]);
});

it("detects markers in a file larger than the previous scan byte limit without reading it whole", () => {
  const largeFile = "generated/large.txt";
  // 10 MiB of filler keeps the marker beyond the old buffered scan limit.
  const filler = ("a".repeat(10240) + "\n").repeat(1024);
  expect(scan({ [largeFile]: filler + conflict })).toEqual([
    { filePath: largeFile, lines: [1025, 1027, 1029] },
  ]);
});

it.each([false, true])("main reports tracked violations through a symlink: %s", (symlink) => {
  const rootDir = createRepository({ "src/conflict.ts": conflict });
  const scriptPath = path.resolve(__dirname, "../../scripts/check-no-conflict-markers.mjs");
  const alias = path.join(rootDir, "script-alias");
  fs.symlinkSync(path.dirname(scriptPath), alias, "junction");
  const entry = symlink ? path.join(alias, path.basename(scriptPath)) : scriptPath;
  const result = spawnSync(process.execPath, [entry], {
    cwd: rootDir,
    encoding: "utf8",
    timeout: 10_000,
  });
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("Found unresolved merge conflict markers:");
  expect(result.stderr).toContain("- src/conflict.ts:1,3,5");
});
