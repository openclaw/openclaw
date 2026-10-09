import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  collectTempCreationFindingsFromDiff,
  formatGithubWarning,
} from "../../scripts/report-test-temp-creations.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { createNestedGitEnv } from "../helpers/temp-repo.js";

const repoRoot = process.cwd();
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function addedDiff(file: string, lines: string[], startLine = 1) {
  return [
    `diff --git a/${file} b/${file}`,
    `--- a/${file}`,
    `+++ b/${file}`,
    `@@ -1,0 +${startLine},${lines.length} @@`,
    ...lines.map((line) => `+${line}`),
  ].join("\n");
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
  const report = (...args: string[]) =>
    spawnSync(
      process.execPath,
      [path.join(repoRoot, "scripts", "report-test-temp-creations.mjs"), ...args],
      { cwd: root, encoding: "utf8", env },
    );
  git("init", "-q", "--initial-branch=main");
  return { root, git, report };
}

describe("report-test-temp-creations", () => {
  it("reports added bare temp creation lines using changed-lane test path scope", () => {
    const bareTempSource = [
      "const tempRoot = fs.",
      "mkdtemp",
      'Sync(path.join(os.tmpdir(), "case-"));',
    ].join("");
    const mkdtempSource = ["const tempRoot = fs.", "mkdtemp", 'Sync("case-");'].join("");
    const diff = [
      addedDiff(
        "src/example.test.ts",
        [
          bareTempSource,
          'const helperRoot = makeTempDir(tempDirs, "case-");',
          "console.log(tempRoot, helperRoot);",
        ],
        11,
      ),
      addedDiff(
        "src/example.ts",
        [["const productionTemp = fs.", "mkdtemp", 'Sync("case-");'].join("")],
        5,
      ),
      ...[
        "test/helper.test-support.mjs",
        "test/helpers/temp-fixture.ts",
        "test/helpers/temp-dir.ts",
        "packages/foo/__tests__/helper.ts",
        "extensions/discord/src/monitor/message-handler.test-helpers.ts",
      ].map((file) => addedDiff(file, [mkdtempSource], 2)),
    ].join("\n");

    expect(collectTempCreationFindingsFromDiff(diff)).toEqual([
      {
        file: "src/example.test.ts",
        line: 11,
        reason: "new mkdtemp temp directory creation",
        source: bareTempSource,
      },
      ...[
        "test/helper.test-support.mjs",
        "test/helpers/temp-fixture.ts",
        "packages/foo/__tests__/helper.ts",
        "extensions/discord/src/monitor/message-handler.test-helpers.ts",
      ].map((file) => ({
        file,
        line: 2,
        reason: "new mkdtemp temp directory creation",
        source: mkdtempSource,
      })),
    ]);
  });

  it("reports repository-observed mkdtemp call forms", () => {
    const sources = [
      ["const root = await fs.promises.", "mkdtemp", '(path.join(os.tmpdir(), "case-"));'].join(""),
      ["const root = await fs.", "mkdtemp", '(path.join(os.tmpdir(), "case-"));'].join(""),
      ["const root = await fsPromises.", "mkdtemp", '("/tmp/openclaw-case-");'].join(""),
      ["const root = await ", "mkdtemp", '(path.join(tmpdir(), "case-"));'].join(""),
      ["const root = ", "mkdtemp", 'Sync(join(tmpdir(), "case-"));'].join(""),
    ];
    const diff = addedDiff("test/scripts/temp-patterns.test.ts", sources);

    expect(collectTempCreationFindingsFromDiff(diff)).toEqual(
      sources.map((source, index) => ({
        file: "test/scripts/temp-patterns.test.ts",
        line: index + 1,
        reason: "new mkdtemp temp directory creation",
        source,
      })),
    );
  });

  it("honors explicit allow comments with reasons", () => {
    const mkdtempCall = ["fs.", "mkdtemp", 'Sync("case-")'].join("");
    const tmpDirCall = ["tmp.", "dir", 'Sync({ prefix: "case-" })'].join("");
    const allowedSource = `const allowed = ${mkdtempCall};`;
    const inlineAllowedSource = `const inlineAllowed = ${tmpDirCall}; // openclaw-temp-dir: allow verifies tmp API behavior`;
    const blockedSource = `const blocked = ${mkdtempCall};`;
    const stringMarkerSource = `const stringMarker = ${mkdtempCall}; const note = "openclaw-temp-dir: allow quoted text";`;
    const emptyReasonSource = `const emptyReason = ${mkdtempCall};`;
    const diff = [
      addedDiff(
        "test/helpers/raw-temp.test.ts",
        [
          "// openclaw-temp-dir: allow verifies raw fs cleanup behavior",
          allowedSource,
          inlineAllowedSource,
          blockedSource,
          stringMarkerSource,
        ],
        2,
      ),
      addedDiff(
        "test/helpers/empty-allow.test.ts",
        ["// openclaw-temp-dir: allow", emptyReasonSource],
        2,
      ),
    ].join("\n");

    expect(collectTempCreationFindingsFromDiff(diff)).toEqual([
      {
        file: "test/helpers/raw-temp.test.ts",
        line: 5,
        reason: "new mkdtemp temp directory creation",
        source: blockedSource,
      },
      {
        file: "test/helpers/raw-temp.test.ts",
        line: 6,
        reason: "new mkdtemp temp directory creation",
        source: stringMarkerSource,
      },
      {
        file: "test/helpers/empty-allow.test.ts",
        line: 3,
        reason: "new mkdtemp temp directory creation",
        source: emptyReasonSource,
      },
    ]);
  });

  it("reports added imports and calls for manual temp-dir helpers", () => {
    const file = "test/scripts/manual-temp.test.ts";
    const source = [
      'import { afterEach } from "vitest";',
      'import { cleanupTempDirs, makeTempDir } from "../helpers/temp-dir.js";',
      "const tempDirs = new Set<string>();",
      "afterEach(() => cleanupTempDirs(tempDirs));",
      'const workspace = makeTempDir(tempDirs, "case-");',
    ].join("\n");
    const diff = addedDiff(file, source.split("\n"));

    expect(
      collectTempCreationFindingsFromDiff(diff, { fileTextByPath: { [file]: source } }),
    ).toEqual([
      {
        file,
        line: 2,
        reason: "new manual temp-dir helper import",
        source: 'import { cleanupTempDirs, makeTempDir } from "../helpers/temp-dir.js";',
      },
      {
        file,
        line: 4,
        reason: "new manual temp-dir helper usage",
        source: "afterEach(() => cleanupTempDirs(tempDirs));",
      },
      {
        file,
        line: 5,
        reason: "new manual temp-dir helper usage",
        source: 'const workspace = makeTempDir(tempDirs, "case-");',
      },
    ]);
  });

  it("reports multiline imports from the shared temp-dir helper", () => {
    const file = "src/example.test.ts";
    const source = [
      "import {",
      "  createTempDirTracker,",
      '} from "../test/helpers/temp-dir.js";',
      "const tempDirs = createTempDirTracker();",
    ].join("\n");
    const diff = addedDiff(file, source.split("\n"));

    expect(
      collectTempCreationFindingsFromDiff(diff, { fileTextByPath: { [file]: source } }),
    ).toEqual([
      {
        file,
        line: 2,
        reason: "new manual temp-dir helper import",
        source: 'import { createTempDirTracker, } from "../test/helpers/temp-dir.js";',
      },
      {
        file,
        line: 4,
        reason: "new manual temp-dir helper usage",
        source: "const tempDirs = createTempDirTracker();",
      },
    ]);
  });

  it("reports manual helpers added to existing multiline imports", () => {
    const file = "test/scripts/manual-temp.test.ts";
    const source = [
      "import {",
      "  useAutoCleanupTempDirTracker,",
      "  makeTempDir,",
      '} from "../helpers/temp-dir.js";',
      "const tempDirs = useAutoCleanupTempDirTracker(afterEach);",
    ].join("\n");
    const diff = [
      "diff --git a/test/scripts/manual-temp.test.ts b/test/scripts/manual-temp.test.ts",
      "--- a/test/scripts/manual-temp.test.ts",
      "+++ b/test/scripts/manual-temp.test.ts",
      "@@ -1,3 +1,4 @@",
      " import {",
      "   useAutoCleanupTempDirTracker,",
      "+  makeTempDir,",
      ' } from "../helpers/temp-dir.js";',
    ].join("\n");

    expect(
      collectTempCreationFindingsFromDiff(diff, { fileTextByPath: { [file]: source } }),
    ).toEqual([
      {
        file,
        line: 3,
        reason: "new manual temp-dir helper import",
        source:
          'import { useAutoCleanupTempDirTracker, makeTempDir, } from "../helpers/temp-dir.js";',
      },
    ]);
  });

  it("allows the auto-cleaning temp-dir helper", () => {
    const file = "test/scripts/auto-temp.test.ts";
    const source = [
      'import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";',
      "const tempDirs = useAutoCleanupTempDirTracker(afterEach);",
      'const workspace = tempDirs.make("case-");',
    ].join("\n");
    const diff = addedDiff(file, source.split("\n"));

    expect(
      collectTempCreationFindingsFromDiff(diff, { fileTextByPath: { [file]: source } }),
    ).toEqual([]);
  });

  it("ignores manual helper fixture strings and the helper test file", () => {
    const fixtureFile = "test/scripts/report-test-temp-creations.test.ts";
    const helperTestFile = "test/helpers/temp-dir.test.ts";
    const fixtureSource = [
      'import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";',
      'const fixture = "makeTempDir(tempDirs, \\"case-\\")";',
    ].join("\n");
    const helperTestSource = [
      'import { createTempDirTracker } from "./temp-dir.js";',
      "const tempDirs = createTempDirTracker();",
    ].join("\n");
    const diff = [
      "diff --git a/test/scripts/report-test-temp-creations.test.ts b/test/scripts/report-test-temp-creations.test.ts",
      "--- a/test/scripts/report-test-temp-creations.test.ts",
      "+++ b/test/scripts/report-test-temp-creations.test.ts",
      "@@ -1,0 +1,5 @@",
      '+const importFixture = "import { makeTempDir } from \\"../helpers/temp-dir.js\\";";',
      "+const callFixture = [",
      '+  "makeTempDir",',
      '+  "(tempDirs, \\"case-\\")",',
      '+].join("");',
      "diff --git a/test/helpers/temp-dir.test.ts b/test/helpers/temp-dir.test.ts",
      "--- a/test/helpers/temp-dir.test.ts",
      "+++ b/test/helpers/temp-dir.test.ts",
      "@@ -1,0 +1,2 @@",
      '+import { createTempDirTracker } from "./temp-dir.js";',
      "+const tempDirs = createTempDirTracker();",
    ].join("\n");

    expect(
      collectTempCreationFindingsFromDiff(diff, {
        fileTextByPath: {
          [fixtureFile]: fixtureSource,
          [helperTestFile]: helperTestSource,
        },
      }),
    ).toEqual([]);
  });

  it("prints help with usage, outputs, and examples", () => {
    const output = execFileSync(
      process.execPath,
      [path.join(repoRoot, "scripts", "report-test-temp-creations.mjs"), "--help"],
      {
        cwd: repoRoot,
        encoding: "utf8",
      },
    );

    expect(output).toContain("Usage: node scripts/report-test-temp-creations.mjs");
    expect(output).toContain("Outputs:");
    expect(output).toContain("--no-merge-base");
    expect(output).toContain("Examples:");
  });

  it("formats GitHub warning annotations for CI report mode", () => {
    expect(
      formatGithubWarning({
        file: "test/helpers/temp,fixture.ts",
        line: 12,
        reason: "new mkdtemp temp directory creation",
        // openclaw-temp-dir: allow test fixture for GitHub warning formatting
        source: "const tempRoot = fs.mkdtempSync();",
      }),
    ).toBe(
      "::warning file=test/helpers/temp%2Cfixture.ts,line=12::new mkdtemp temp directory creation: prefer useAutoCleanupTempDirTracker(afterEach) from test/helpers/temp-dir.ts for new test-owned temp directories.",
    );
  });

  it("handles large data and test-directory docs in staged and branch reports", () => {
    const { root, git, report } = createGitFixture("openclaw-temp-report-large-diff-");
    const jsonReport = (...args: string[]) => {
      const result = report(...args, "--json");
      expect(result.status, result.stderr.split("\n")[0]).toBe(0);
      return JSON.parse(result.stdout);
    };
    git("commit", "--allow-empty", "-q", "-m", "base");
    fs.mkdirSync(path.join(root, "generated"));
    fs.writeFileSync(
      path.join(root, "generated", "catalog.json"),
      Buffer.alloc(65 * 1024 * 1024, "x"),
    );
    const doc = "docs/reference/test/runner-internals.md";
    fs.mkdirSync(path.dirname(path.join(root, doc)), { recursive: true });
    fs.writeFileSync(path.join(root, doc), "# Test runner\n\nManual setup notes.\n");
    git("add", "generated/catalog.json", doc);
    expect(jsonReport("--staged")).toEqual([]);

    fs.mkdirSync(path.join(root, "src"));
    const file = "src/case[1].test.ts";
    const source = ["const root = fs.", "mkdtemp", 'Sync("case-");'].join("");
    fs.writeFileSync(path.join(root, file), `${source}\n`);
    git("--literal-pathspecs", "add", "--", file);
    const expected = [{ file, line: 1, reason: "new mkdtemp temp directory creation", source }];
    expect(jsonReport("--staged")).toEqual(expected);
    git("commit", "-q", "-m", "generated data and test");
    expect(jsonReport("--staged")).toEqual([]);
    expect(jsonReport("--staged", "--base", "HEAD^")).toEqual(expected);
    expect(jsonReport("--base", "HEAD^", "--head", "HEAD")).toEqual(expected);
    expect(jsonReport("--base", "HEAD^", "--head", "HEAD", "--no-merge-base")).toEqual(expected);
  });

  it.each(["rename", "copy"])("preserves added-line scope for %s into and out of tests", (mode) => {
    const { root, git, report } = createGitFixture("openclaw-temp-report-renames-");
    git("config", "diff.renames", mode === "copy" ? "copies" : "true");
    fs.mkdirSync(path.join(root, "src"));
    const existing = ["const existing = fs.", "mkdtemp", 'Sync("old-");'].join("");
    fs.writeFileSync(path.join(root, "src", "enter.ts"), `${existing}\n// entering tests\n`);
    fs.writeFileSync(path.join(root, "src", "leave.test.ts"), `${existing}\n// leaving tests\n`);
    git("add", "src");
    git("commit", "-q", "-m", "base");
    for (const [from, to] of Object.entries({
      "src/enter.ts": "src/enter.test.ts",
      "src/leave.test.ts": "src/leave.ts",
    })) {
      if (mode === "rename") {
        git("mv", from, to);
      } else {
        fs.copyFileSync(path.join(root, from), path.join(root, to));
        fs.appendFileSync(path.join(root, from), "// changed copy source\n");
      }
    }
    const source = ["const added = fs.", "mkdtemp", 'Sync("new-");'].join("");
    fs.appendFileSync(path.join(root, "src", "enter.test.ts"), `${source}\n`);
    fs.appendFileSync(path.join(root, "src", "leave.ts"), `${source}\n`);
    git("add", "src");

    const result = report("--staged", "--json");
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual([
      { file: "src/enter.test.ts", line: 3, reason: "new mkdtemp temp directory creation", source },
    ]);
  });

  it("reads staged source for manual helper scans", () => {
    const { root, git, report } = createGitFixture("openclaw-temp-report-staged-source-");
    git("commit", "--allow-empty", "-q", "-m", "initial");

    fs.mkdirSync(path.join(root, "test", "scripts"), { recursive: true });
    const stagedManualFile = path.join(root, "test", "scripts", "staged-manual.test.ts");
    const stagedAutoFile = path.join(root, "test", "scripts", "staged-auto.test.ts");
    const manualSource = [
      'import { makeTempDir } from "../helpers/temp-dir.js";',
      "const tempDirs = new Set<string>();",
      'const workspace = makeTempDir(tempDirs, "case-");',
    ].join("\n");
    const autoSource = [
      'import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";',
      "const tempDirs = useAutoCleanupTempDirTracker(afterEach);",
      'const workspace = tempDirs.make("case-");',
    ].join("\n");
    fs.writeFileSync(stagedManualFile, `${manualSource}\n`, "utf8");
    fs.writeFileSync(stagedAutoFile, `${autoSource}\n`, "utf8");
    git("add", "test/scripts");
    fs.writeFileSync(stagedManualFile, `${autoSource}\n`, "utf8");
    fs.writeFileSync(stagedAutoFile, `${manualSource}\n`, "utf8");

    const result = report("--staged", "--json");

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual([
      {
        file: "test/scripts/staged-manual.test.ts",
        line: 1,
        reason: "new manual temp-dir helper import",
        source: 'import { makeTempDir } from "../helpers/temp-dir.js";',
      },
      {
        file: "test/scripts/staged-manual.test.ts",
        line: 3,
        reason: "new manual temp-dir helper usage",
        source: 'const workspace = makeTempDir(tempDirs, "case-");',
      },
    ]);
  });

  it("exits non-zero for staged findings when requested", () => {
    const { root, git, report } = createGitFixture("openclaw-temp-report-");
    fs.mkdirSync(path.join(root, "test", "helpers"), { recursive: true });
    fs.writeFileSync(path.join(root, "test", "helpers", "case.ts"), "const value = 1;\n", "utf8");
    git("add", "test/helpers/case.ts");
    git("commit", "-q", "-m", "initial");

    const source = [
      "const tempRoot = fs.",
      "mkdtemp",
      'Sync(path.join(os.tmpdir(), "case-"));\n',
    ].join("");
    fs.appendFileSync(path.join(root, "test", "helpers", "case.ts"), source, "utf8");
    git("add", "test/helpers/case.ts");

    const result = report("--staged", "--fail-on-findings");

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("test/helpers/case.ts");
  });

  it("falls back to a two-dot diff when refs have no merge base", () => {
    const { root, git, report } = createGitFixture("openclaw-temp-report-no-merge-base-");
    git("commit", "--allow-empty", "-q", "-m", "base");
    git("checkout", "--orphan", "feature", "-q");
    fs.mkdirSync(path.join(root, "test", "scripts"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "test", "scripts", "feature.test.ts"),
      'const tempRoot = fs.mkdtempSync("case-");\n',
      "utf8",
    );
    git("add", "test/scripts/feature.test.ts");
    git("commit", "-q", "-m", "feature");

    const result = report("--base", "main", "--head", "feature", "--json");

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual([
      {
        file: "test/scripts/feature.test.ts",
        line: 1,
        reason: "new mkdtemp temp directory creation",
        source: 'const tempRoot = fs.mkdtempSync("case-");',
      },
    ]);
  });
});
