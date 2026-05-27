import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  collectTempCreationFindingsFromDiff,
  formatGithubWarning,
} from "../../scripts/report-test-temp-creations.mjs";
import { createTempDirTracker } from "../helpers/temp-dir.js";

const repoRoot = process.cwd();
const tempDirs = createTempDirTracker();
const nestedGitEnvKeys = [
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_DIR",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_QUARANTINE_PATH",
  "GIT_WORK_TREE",
] as const;

function createNestedGitEnv(): NodeJS.ProcessEnv {
  const env = {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
  };
  for (const key of nestedGitEnvKeys) {
    delete env[key];
  }
  return env;
}

afterEach(() => {
  tempDirs.cleanup();
});

describe("report-test-temp-creations", () => {
  it("reports added bare temp creation lines using changed-lane test path scope", () => {
    const bareTempSource = [
      "const tempRoot = fs.",
      "mkdtemp",
      'Sync(path.join(os.tmpdir(), "case-"));',
    ].join("");
    const mkdtempSource = ["const tempRoot = fs.", "mkdtemp", 'Sync("case-");'].join("");
    const diff = [
      "diff --git a/src/example.test.ts b/src/example.test.ts",
      "--- a/src/example.test.ts",
      "+++ b/src/example.test.ts",
      "@@ -10,0 +11,3 @@",
      `+${bareTempSource}`,
      '+const helperRoot = makeTempDir(tempDirs, "case-");',
      "+console.log(tempRoot, helperRoot);",
      "diff --git a/src/example.ts b/src/example.ts",
      "--- a/src/example.ts",
      "+++ b/src/example.ts",
      "@@ -4,0 +5,1 @@",
      `+${["const productionTemp = fs.", "mkdtemp", 'Sync("case-");'].join("")}`,
      "diff --git a/test/helper.test-support.mjs b/test/helper.test-support.mjs",
      "--- a/test/helper.test-support.mjs",
      "+++ b/test/helper.test-support.mjs",
      "@@ -1,0 +2,1 @@",
      `+${mkdtempSource}`,
      "diff --git a/test/helpers/temp-fixture.ts b/test/helpers/temp-fixture.ts",
      "--- a/test/helpers/temp-fixture.ts",
      "+++ b/test/helpers/temp-fixture.ts",
      "@@ -1,0 +2,1 @@",
      `+${mkdtempSource}`,
      "diff --git a/packages/foo/__tests__/helper.ts b/packages/foo/__tests__/helper.ts",
      "--- a/packages/foo/__tests__/helper.ts",
      "+++ b/packages/foo/__tests__/helper.ts",
      "@@ -1,0 +2,1 @@",
      `+${mkdtempSource}`,
      "diff --git a/extensions/discord/src/monitor/message-handler.test-helpers.ts b/extensions/discord/src/monitor/message-handler.test-helpers.ts",
      "--- a/extensions/discord/src/monitor/message-handler.test-helpers.ts",
      "+++ b/extensions/discord/src/monitor/message-handler.test-helpers.ts",
      "@@ -1,0 +2,1 @@",
      `+${mkdtempSource}`,
    ].join("\n");

    expect(collectTempCreationFindingsFromDiff(diff)).toEqual([
      {
        file: "src/example.test.ts",
        line: 11,
        reason: "new mkdtemp temp directory creation",
        source: bareTempSource,
      },
      {
        file: "test/helper.test-support.mjs",
        line: 2,
        reason: "new mkdtemp temp directory creation",
        source: mkdtempSource,
      },
      {
        file: "test/helpers/temp-fixture.ts",
        line: 2,
        reason: "new mkdtemp temp directory creation",
        source: mkdtempSource,
      },
      {
        file: "packages/foo/__tests__/helper.ts",
        line: 2,
        reason: "new mkdtemp temp directory creation",
        source: mkdtempSource,
      },
    ]);
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
    expect(output).toContain("Examples:");
  });

  it("formats GitHub warning annotations for CI report mode", () => {
    expect(
      formatGithubWarning({
        file: "test/helpers/temp,fixture.ts",
        line: 12,
        reason: "new mkdtemp temp directory creation",
        source: "const tempRoot = fs.mkdtempSync();",
      }),
    ).toBe(
      "::warning file=test/helpers/temp%2Cfixture.ts,line=12::new mkdtemp temp directory creation: prefer test/helpers/temp-dir.ts for new test-owned temp directories.",
    );
  });

  it("exits non-zero for staged findings when requested", () => {
    const root = tempDirs.make("openclaw-temp-report-");
    const env = createNestedGitEnv();
    execFileSync("git", ["init", "-q", "--initial-branch=main"], { cwd: root, env });
    fs.mkdirSync(path.join(root, "test", "helpers"), { recursive: true });
    fs.writeFileSync(path.join(root, "test", "helpers", "case.ts"), "const value = 1;\n", "utf8");
    execFileSync("git", ["add", "test/helpers/case.ts"], { cwd: root, env });
    execFileSync(
      "git",
      [
        "-c",
        "user.email=test@example.com",
        "-c",
        "user.name=Test User",
        "commit",
        "-q",
        "-m",
        "initial",
      ],
      { cwd: root, env },
    );

    const source = [
      "const tempRoot = fs.",
      "mkdtemp",
      'Sync(path.join(os.tmpdir(), "case-"));\n',
    ].join("");
    fs.appendFileSync(path.join(root, "test", "helpers", "case.ts"), source, "utf8");
    execFileSync("git", ["add", "test/helpers/case.ts"], { cwd: root, env });

    const result = spawnSync(
      process.execPath,
      [
        path.join(repoRoot, "scripts", "report-test-temp-creations.mjs"),
        "--staged",
        "--fail-on-findings",
      ],
      {
        cwd: root,
        encoding: "utf8",
        env,
      },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("test/helpers/case.ts");
  });
});
