import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  collectCurrentSuppressionState,
  collectLintDisableDirectives,
  isGovernedSourcePath,
  main,
} from "../../scripts/check-max-lines-ratchet.mts";
import { createNativeTypeScriptParser } from "../../scripts/lib/native-typescript.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { createNestedGitEnv } from "../helpers/temp-repo.js";

const parser = createNativeTypeScriptParser();
afterAll(() => parser.close());

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
beforeEach(() => vi.stubEnv("GITHUB_ACTIONS", ""));
const nestedGitEnvKeys = new Set(
  (
    "ALTERNATE_OBJECT_DIRECTORIES COMMON_DIR CONFIG CONFIG_COUNT CONFIG_PARAMETERS DIR " +
    "GRAFT_FILE IMPLICIT_WORK_TREE INDEX_FILE NAMESPACE NO_REPLACE_OBJECTS OBJECT_DIRECTORY " +
    "PREFIX QUARANTINE_PATH REPLACE_REF_BASE SHALLOW_FILE WORK_TREE"
  )
    .split(" ")
    .map((key) => `GIT_${key}`),
);

function git(cwd: string, args: string[]): void {
  const env = Object.fromEntries(
    Object.entries(createNestedGitEnv()).filter(([key]) => !nestedGitEnvKeys.has(key)),
  );
  execFileSync("git", ["-c", "user.email=test@example.com", "-c", "user.name=Test", ...args], {
    cwd,
    env,
    stdio: "ignore",
  });
}

const baselinePath = "config/max-lines-baseline.txt";
const suppression = "/* oxlint-disable max-lines */\n";
function write(root: string, file: string, source: string) {
  const target = path.join(root, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, source);
}

function makeRepo(entries: string[], files: Record<string, string> = {}, message = "base") {
  const root = tempDirs.make("openclaw-max-lines-");
  write(root, baselinePath, entries.map((file) => `${file}\n`).join(""));
  entries.forEach((file) => write(root, file, suppression));
  Object.entries(files).forEach(([file, source]) => write(root, file, source));
  [["init"], ["add", "."], ["commit", "-m", message]].forEach((args) => git(root, args));
  return root;
}

const directives = (source: string) =>
  collectLintDisableDirectives(source, "file.ts", parser.parseSourceFile("file.ts", source));

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it("preserves directive discovery with CRLF line endings", () => {
  const source = [
    'const text = "\u{1f680} /* oxlint-disable max-lines */"; const template = `// eslint-disable max-lines`;',
    "function example() { /* oxlint-disable no-console */ } // eslint-disable no-debugger",
    "consume(1 // oxlint-disable no-console",
    ");",
    "// eslint-disable max-lines, eqeqeq",
  ].join("\r\n");

  const noLog = ["no-console"];
  expect(directives(source)).toEqual([noLog, ["no-debugger"], noLog, ["max-lines", "eqeqeq"]]);
});

it("does not match directive examples in prose", () => {
  expect(directives("// Example: oxlint-disable max-lines\n")).toEqual([]);
});

it.each([
  ["src/runtime.ts", true],
  ["extensions/demo/index.mjs", true],
  ["scripts/tool.mjs", false],
  ["packages/api/protocol-gen/types.ts", false],
  ["ui/src/i18n/locales/en.ts", false],
  ["src/wizard/i18n/locales/en.ts", false],
  ["src/schema.generated.ts", false],
] as const)("governs %s: %s", (file, governed) => {
  expect(isGovernedSourcePath(file)).toBe(governed);
});

it("reports baseline growth as an advisory in GitHub Actions even when listed", () => {
  const root = makeRepo(["src/a.ts"]);
  write(root, baselinePath, "src/a.ts\nsrc/b.ts\n");
  write(root, "src/b.ts", suppression);
  git(root, ["add", "."]);
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  vi.stubEnv("GITHUB_ACTIONS", "true");
  vi.stubEnv("GITHUB_STEP_SUMMARY", path.join(root, "summary.md"));
  expect(main(root, ["--base", "HEAD"])).toBe(0);
  expect(error).toHaveBeenCalledWith(
    expect.stringContaining("The max-lines baseline may only shrink"),
  );
  expect(fs.readFileSync(path.join(root, "summary.md"), "utf8")).toContain("src/b.ts");
});

it("transfers grandfathered debt across a verified rename", () => {
  const root = makeRepo(["src/a.ts"], {
    "src/a.ts": "export const a = 1;\n/* oxlint-disable max-lines -- TODO: split. */\n",
  });
  git(root, ["update-ref", "refs/remotes/origin/main", "HEAD"]);

  git(root, ["mv", "src/a.ts", "src/b.ts"]);
  write(root, baselinePath, "src/b.ts\n");

  expect(main(root)).toBe(0);
});

it("compares an explicit moving base at the branch fork", () => {
  const root = makeRepo(["src/a.ts", "src/b.ts"]);
  git(root, ["branch", "release"]);

  write(root, baselinePath, "src/a.ts\n");
  write(root, "src/b.ts", "export const b = 1;\n");
  git(root, ["add", "."]);
  git(root, ["commit", "-m", "shrink main debt"]);
  git(root, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
  git(root, ["checkout", "release"]);

  expect(main(root, ["--base", "origin/main"])).toBe(0);
});

it("rejects unavailable ancestry with an explicit prepared-base recovery", () => {
  const root = makeRepo(["src/a.ts"], {}, "release");
  git(root, ["branch", "-m", "release"]);
  git(root, ["checkout", "--orphan", "main"]);
  write(root, baselinePath, "");
  write(root, "src/a.ts", "export const a = 1;\n");
  git(root, ["add", "."]);
  git(root, ["commit", "-m", "disconnected main"]);
  git(root, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
  git(root, ["checkout", "release"]);

  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  expect(main(root)).toBe(1);
  expect(errors).toHaveBeenCalledWith(
    "Could not resolve ratchet merge base for origin/main; provide reachable history or --base <prepared-ref> --no-merge-base.",
  );
});

it("checks staged content instead of unstaged worktree edits", () => {
  const root = makeRepo([], { "src/a.ts": "export const a = 1;\n" });
  write(root, baselinePath, "src/a.ts\n");
  write(root, "src/a.ts", "/* oxlint-disable */\n");
  git(root, ["add", "."]);
  write(root, baselinePath, "");
  write(root, "src/a.ts", "export const a = 1;\n");
  vi.spyOn(console, "error").mockImplementation(() => {});

  expect(main(root, ["--staged", "--base", "HEAD"])).toBe(1);
});

it.skipIf(process.platform === "win32")("keeps staged filenames NUL-framed", () => {
  const filePath = "src/newline\nname.ts";
  const root = makeRepo([filePath]);

  expect(collectCurrentSuppressionState(root, { staged: true }).explicit).toEqual([filePath]);
});

it("checks untracked sources and tolerates unstaged deletions", () => {
  const root = makeRepo([], { "src/deleted.ts": "export const deleted = true;\n" });
  git(root, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
  fs.rmSync(path.join(root, "src/deleted.ts"));
  expect(main(root)).toBe(0);

  write(root, "src/untracked.ts", "// eslint-disable-next-line eslint/max-lines\n");
  vi.spyOn(console, "error").mockImplementation(() => {});

  expect(main(root)).toBe(1);
});
