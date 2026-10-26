import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { collectEnvVarNames } from "../../scripts/check-env-var-count.mts";
import { collectCurrentSuppressionState, main } from "../../scripts/check-max-lines-ratchet.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { createNestedGitEnv } from "../helpers/temp-repo.js";

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

function makeRepo(entries: string[], files: Record<string, string> = {}) {
  const root = tempDirs.make("openclaw-max-lines-");
  write(root, baselinePath, entries.map((file) => `${file}\n`).join(""));
  entries.forEach((file) => write(root, file, suppression));
  Object.entries(files).forEach(([file, source]) => write(root, file, source));
  [["init"], ["add", "."], ["commit", "-m", "base"]].forEach((args) => git(root, args));
  return root;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
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

it("blocks a moved suppression and its stale entry in GitHub Actions", () => {
  const root = makeRepo(["src/page.ts"]);
  git(root, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
  fs.rmSync(path.join(root, "src/page.ts"));
  write(root, "src/page-state.ts", "export const state = 1;\n" + suppression);
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  vi.stubEnv("GITHUB_ACTIONS", "true");

  expect(main(root)).toBe(1);
  expect(error).toHaveBeenCalledWith(
    expect.stringMatching(/New max-lines suppressions are forbidden.*\n {2}src\/page-state\.ts$/u),
  );

  write(root, "src/page-state.ts", "export const state = 1;\n");
  expect(main(root)).toBe(1);
  expect(error).toHaveBeenLastCalledWith(
    "Remove stale max-lines baseline entries (or run with --prune):\n  src/page.ts",
  );
});

it("transfers grandfathered debt across a verified rename", () => {
  const root = makeRepo(["src/a.ts"]);
  git(root, ["update-ref", "refs/remotes/origin/main", "HEAD"]);

  git(root, ["mv", "src/a.ts", "src/b.ts"]);
  write(root, baselinePath, "src/b.ts\n");

  expect(main(root)).toBe(0);
});

it("reports base-resolution failures", () => {
  const root = makeRepo([]);
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  expect(main(root, ["--base", "missing"])).toBe(1);
  expect(errors).toHaveBeenCalledWith("Could not resolve ratchet base ref: missing");
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

it("keeps candidate batches aligned and counts environment names outside them", () => {
  const files = Object.fromEntries(
    Array.from({ length: 5 }, (_, index) => [
      `src/file-${String(index).padStart(2, "0")}.ts`,
      'const example = "🚀 /* oxlint-disable max-lines */"; const template = `// eslint-disable max-lines`;\r\n' +
        "// Example: oxlint-disable max-lines\r\nfunction f() { /* oxlint-disable no-console */ } // eslint-disable no-debugger\r\nconsume(1 // oxlint-disable no-console\r\n);\r\n" +
        (index === 1 ? "/* eslint-disable */\r\n" : "") +
        (index === 4
          ? "// eslint-disable max-lines, eqeqeq\r\nprocess.env.OPENCLAW_SUPPRESSED;\r\n"
          : ""),
    ]),
  );
  const root = makeRepo([], {
    ...files,
    ...Object.fromEntries(
      [
        "scripts/tool.mjs",
        "packages/api/protocol-gen/types.ts",
        "ui/src/i18n/locales/en.ts",
        "src/wizard/i18n/locales/en.ts",
        "src/schema.generated.ts",
      ].map((file) => [file, suppression]),
    ),
    "extensions/demo/index.mjs": suppression,
    ".gitignore": "src/ignored.ts\n",
    "src/plain.ts": "process.env.OPENCLAW_PLAIN;\n",
  });
  write(root, ".gitignore", "src/ignored.ts\nsrc/file-04.ts\n");
  write(root, "src/ignored.ts", "/* eslint-disable */\n");
  write(root, "src/untracked.ts", suppression + "process.env.OPENCLAW_UNTRACKED;\n");
  const envVarNames = new Map<string, ReadonlySet<string>>();

  expect(collectCurrentSuppressionState(root, { envVarNames })).toEqual({
    allRules: ["src/file-01.ts"],
    explicit: ["extensions/demo/index.mjs", "src/file-04.ts", "src/untracked.ts"],
  });
  expect(collectEnvVarNames(root, { preparedNames: envVarNames })).toEqual([
    "OPENCLAW_PLAIN",
    "OPENCLAW_SUPPRESSED",
    "OPENCLAW_UNTRACKED",
  ]);
});

it.skipIf(process.platform === "win32")(
  "reads worktree contents despite indexed types and skip flags",
  () => {
    const root = makeRepo([], {
      "fixture.txt": suppression,
      "src/assumed.ts": "export const value = 1;\n",
      "src/replaced.ts": "export const value = 1;\n",
      "src/skipped.ts": "export const value = 1;\n",
    });
    fs.symlinkSync("../fixture.txt", path.join(root, "src/reverse.ts"));
    fs.symlinkSync("../fixture.txt", path.join(root, "src/tracked.ts"));
    git(root, ["add", "."]);
    git(root, ["update-index", "--assume-unchanged", "src/assumed.ts"]);
    git(root, ["update-index", "--skip-worktree", "src/skipped.ts"]);
    write(root, "src/assumed.ts", suppression);
    write(root, "src/skipped.ts", suppression);
    fs.unlinkSync(path.join(root, "src/replaced.ts"));
    fs.symlinkSync("../fixture.txt", path.join(root, "src/replaced.ts"));
    fs.unlinkSync(path.join(root, "src/reverse.ts"));
    write(root, "src/reverse.ts", suppression);
    fs.symlinkSync("../fixture.txt", path.join(root, "src/untracked.ts"));

    expect(collectCurrentSuppressionState(root)).toEqual({
      allRules: [],
      explicit: [
        "src/assumed.ts",
        "src/replaced.ts",
        "src/reverse.ts",
        "src/skipped.ts",
        "src/tracked.ts",
        "src/untracked.ts",
      ],
    });
  },
);
