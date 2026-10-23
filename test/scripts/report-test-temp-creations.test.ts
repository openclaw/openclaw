import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  collectTempCreationFindingsFromDiff as collectFindings,
  formatGithubWarning,
} from "../../scripts/report-test-temp-creations.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { createNestedGitEnv } from "../helpers/temp-repo.js";

const repoRoot = process.cwd();
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function diffHeader(file: string) {
  return [`diff --git a/${file} b/${file}`, `--- a/${file}`, `+++ b/${file}`];
}

function addedDiff(file: string, lines: readonly string[], startLine = 1) {
  return [
    ...diffHeader(file),
    `@@ -1,0 +${startLine},${lines.length} @@`,
    ...lines.map((line) => `+${line}`),
  ].join("\n");
}

const rawReason = "new mkdtemp temp directory creation";
function finding(file: string, line: number, source: string, reason = rawReason) {
  return { file, line, reason, source };
}

function createGitFixture(prefix: string) {
  const root = tempDirs.make(prefix);
  const env = createNestedGitEnv();
  const git = (...args: string[]) =>
    execFileSync(
      "git",
      ["-c", "user.email=test@example.com", "-c", "user.name=Test User", ...args],
      { cwd: root, env },
    );
  const report = (...args: string[]) => {
    const result = spawnSync(
      process.execPath,
      [path.join(repoRoot, "scripts", "report-test-temp-creations.mjs"), ...args, "--json"],
      { cwd: root, encoding: "utf8", env },
    );
    expect(result.status, result.stderr.split("\n")[0]).toBe(0);
    return JSON.parse(result.stdout);
  };
  const write = (file: string, contents: string | Buffer) => {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), contents);
  };
  git("init", "-q", "--initial-branch=main");
  return { write, git, report };
}

describe("report-test-temp-creations", () => {
  it("honors explicit allow comments with reasons", () => {
    const mkdtempCall = ["fs.", "mkdtemp", 'Sync("case-")'].join("");
    const tmpDirCall = ["tmp.", "dir", 'Sync({ prefix: "case-" })'].join("");
    const lines = [
      "// openclaw-temp-dir: allow verifies raw fs cleanup behavior",
      `const allowed = ${mkdtempCall};`,
      `const inlineAllowed = ${tmpDirCall}; // openclaw-temp-dir: allow verifies tmp API behavior`,
      `const blocked = ${mkdtempCall};`,
      `const stringMarker = ${mkdtempCall}; const note = "openclaw-temp-dir: allow quoted text";`,
    ] as const;
    const emptyReasonSource = `const emptyReason = ${mkdtempCall};`;
    const diff = [
      addedDiff("test/helpers/raw-temp.test.ts", lines, 2),
      addedDiff(
        "test/helpers/empty-allow.test.ts",
        ["// openclaw-temp-dir: allow", emptyReasonSource],
        2,
      ),
    ].join("\n");

    expect(collectFindings(diff)).toEqual([
      finding("test/helpers/raw-temp.test.ts", 5, lines[3]),
      finding("test/helpers/raw-temp.test.ts", 6, lines[4]),
      finding("test/helpers/empty-allow.test.ts", 3, emptyReasonSource),
    ]);
  });

  it("reports added imports and calls for manual temp-dir helpers", () => {
    const file = "test/scripts/manual-temp.test.ts";
    const lines = [
      'import { afterEach } from "vitest";',
      'import { cleanupTempDirs, makeTempDir } from "../helpers/temp-dir.js";',
      "const tempDirs = new Set<string>();",
      "afterEach(() => cleanupTempDirs(tempDirs));",
      'const workspace = makeTempDir(tempDirs, "case-");',
    ] as const;
    expect(
      collectFindings(addedDiff(file, lines), { fileTextByPath: { [file]: lines.join("\n") } }),
    ).toEqual([
      finding(file, 2, lines[1], "new manual temp-dir helper import"),
      finding(file, 4, lines[3], "new manual temp-dir helper usage"),
      finding(file, 5, lines[4], "new manual temp-dir helper usage"),
    ]);
  });

  it("reports manual helpers added to existing multiline imports", () => {
    const file = "test/scripts/manual-temp.test.ts";
    const lines = [
      "import {",
      "  useAutoCleanupTempDirTracker,",
      "  makeTempDir,",
      '} from "../helpers/temp-dir.js";',
      "const tempDirs = useAutoCleanupTempDirTracker(afterEach);",
    ];
    const diff = [
      ...diffHeader(file),
      "@@ -1,3 +1,4 @@",
      ...lines.slice(0, 4).map((line, index) => `${index === 2 ? "+" : " "}${line}`),
    ].join("\n");

    expect(collectFindings(diff, { fileTextByPath: { [file]: lines.join("\n") } })).toEqual([
      finding(
        file,
        3,
        'import { useAutoCleanupTempDirTracker, makeTempDir, } from "../helpers/temp-dir.js";',
        "new manual temp-dir helper import",
      ),
    ]);
  });

  it("ignores manual helper fixture strings and the helper test file", () => {
    const fixtureFile = "test/scripts/report-test-temp-creations.test.ts";
    const helperTestFile = "test/helpers/temp-dir.test.ts";
    const fileTextByPath = {
      [fixtureFile]: [
        'import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";',
        'const fixture = "makeTempDir(tempDirs, \\"case-\\")";',
      ].join("\n"),
      [helperTestFile]:
        'import { createTempDirTracker } from "./temp-dir.js";\nconst tempDirs = createTempDirTracker();',
    };
    const diff = [
      addedDiff(fixtureFile, [
        'const importFixture = "import { makeTempDir } from \\"../helpers/temp-dir.js\\";";',
        "const callFixture = [",
        '  "makeTempDir",',
        '  "(tempDirs, \\"case-\\")",',
        '].join("");',
      ]),
      addedDiff(helperTestFile, fileTextByPath[helperTestFile].split("\n")),
    ].join("\n");

    expect(collectFindings(diff, { fileTextByPath })).toEqual([]);
  });

  it("formats GitHub warning annotations for CI report mode", () => {
    expect(
      formatGithubWarning(
        finding(
          "test/helpers/temp,fixture.ts",
          12,
          // openclaw-temp-dir: allow test fixture for GitHub warning formatting
          "const tempRoot = fs.mkdtempSync();",
        ),
      ),
    ).toBe(
      "::warning file=test/helpers/temp%2Cfixture.ts,line=12::new mkdtemp temp directory creation: prefer useAutoCleanupTempDirTracker(afterEach) from test/helpers/temp-dir.ts for new test-owned temp directories.",
    );
  });

  it("handles large data and test-directory docs in staged and branch reports", () => {
    const { write, git, report } = createGitFixture("openclaw-temp-report-large-diff-");
    git("commit", "--allow-empty", "-q", "-m", "base");
    write("generated/catalog.json", Buffer.alloc(65 * 1024 * 1024, "x"));
    const doc = "docs/reference/test/runner-internals.md";
    write(doc, "# Test runner\n\nManual setup notes.\n");
    git("add", "generated/catalog.json", doc);
    expect(report("--staged")).toEqual([]);

    const file = "src/case[1].test.ts";
    const source = ["const root = fs.", "mkdtemp", 'Sync("case-");'].join("");
    write(file, `${source}\n`);
    git("--literal-pathspecs", "add", "--", file);
    const expected = [finding(file, 1, source)];
    expect(report("--staged")).toEqual(expected);
    git("commit", "-q", "-m", "generated data and test");
    expect(report("--staged")).toEqual([]);
    expect(report("--staged", "--base", "HEAD^")).toEqual(expected);
    expect(report("--base", "HEAD^", "--head", "HEAD")).toEqual(expected);
    expect(report("--base", "HEAD^", "--head", "HEAD", "--no-merge-base")).toEqual(expected);
  });

  it("falls back to a two-dot diff when refs have no merge base", () => {
    const { write, git, report } = createGitFixture("openclaw-temp-report-no-merge-base-");
    git("commit", "--allow-empty", "-q", "-m", "base");
    git("checkout", "--orphan", "feature", "-q");
    const file = "test/scripts/feature.test.ts";
    const source = 'const tempRoot = fs.mkdtempSync("case-");';
    write(file, `${source}\n`);
    git("add", file);
    git("commit", "-q", "-m", "feature");

    expect(report("--base", "main", "--head", "feature")).toEqual([finding(file, 1, source)]);
  });
});
