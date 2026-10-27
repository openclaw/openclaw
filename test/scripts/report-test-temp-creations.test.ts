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
function collect(file: string, lines: string[]) {
  return collectFindings(addedDiff(file, lines), { fileTextByPath: { [file]: lines.join("\n") } });
}

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
    expect(
      collectFindings(
        addedDiff(
          "test/helpers/raw-temp.test.ts",
          [...lines, "// openclaw-temp-dir: allow", emptyReasonSource],
          2,
        ),
      ),
    ).toEqual([
      finding("test/helpers/raw-temp.test.ts", 5, lines[3]),
      finding("test/helpers/raw-temp.test.ts", 6, lines[4]),
      finding("test/helpers/raw-temp.test.ts", 8, emptyReasonSource),
    ]);
  });

  it("reports added imports and calls for manual temp-dir helpers", () => {
    const file = "test/scripts/manual-temp.test.ts";
    const lines = [
      'import { makeTempDir } from "../helpers/temp-dir.js";',
      'const workspace = makeTempDir(tempDirs, "case-");',
    ];
    expect(collect(file, lines)).toEqual([
      finding(file, 1, lines[0]!, "new manual temp-dir helper import"),
      finding(file, 2, lines[1]!, "new manual temp-dir helper usage"),
    ]);
  });

  it("reports manual helpers added to existing multiline imports", () => {
    const file = "test/scripts/manual-temp.test.ts";
    const lines = [
      "import {",
      "  useAutoCleanupTempDirTracker,",
      "  makeTempDir,",
      '} from "../helpers/temp-dir.js";',
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
    expect(
      collect("test/scripts/report-test-temp-creations.test.ts", [
        'const importFixture = "import { makeTempDir } from \\"../helpers/temp-dir.js\\";";',
        'const callFixture = "makeTempDir(tempDirs, \\"case-\\")";',
      ]),
    ).toEqual([]);
    expect(
      collect("test/helpers/temp-dir.test.ts", [
        'import { createTempDirTracker } from "./temp-dir.js";',
        "const tempDirs = createTempDirTracker();",
      ]),
    ).toEqual([]);
  });

  it("formats GitHub warning annotations for CI report mode", () => {
    const warning = formatGithubWarning(finding("test/helpers/temp,fixture.ts", 12, ""));
    expect(warning).toMatch(/^::warning file=test\/helpers\/temp%2Cfixture.ts,line=12::.+$/u);
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
