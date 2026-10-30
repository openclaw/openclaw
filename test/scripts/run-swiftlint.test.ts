import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const repoRoot = process.cwd();
const command = path.join(repoRoot, "scripts/run-swiftlint.mts");
const fixtureFile = "apps/ios/Sources/LimitFixture.swift";

const violation = (rule: string, reason = `Fixture violation of ${rule}`) => ({
  file: path.join(repoRoot, fixtureFile),
  line: 7,
  character: 3,
  severity: "Error",
  rule_id: rule,
  reason,
});

describe.skipIf(process.platform === "win32")("SwiftLint limit policy", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);

  function run(report: unknown, { github = true, exit = 2 } = {}) {
    const fixtureDir = tempDirs.make("openclaw-swiftlint-");
    const summary = path.join(fixtureDir, "summary.md");
    writeFileSync(
      path.join(fixtureDir, "swiftlint"),
      `#!/usr/bin/env node
process.stdout.write(process.env.SWIFTLINT_TEST_REPORT);
process.exitCode = Number(process.env.SWIFTLINT_TEST_EXIT);
`,
      { mode: 0o755 },
    );
    const result = spawnSync(process.execPath, [command, "--strict"], {
      cwd: path.join(repoRoot, "apps/ios"),
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${fixtureDir}${path.delimiter}${process.env.PATH}`,
        CI: "true",
        GITHUB_ACTIONS: github ? "true" : undefined,
        GITHUB_STEP_SUMMARY: summary,
        SWIFTLINT_TEST_REPORT: typeof report === "string" ? report : JSON.stringify(report),
        SWIFTLINT_TEST_EXIT: String(exit),
      },
    });
    const read = (file: string) => (existsSync(file) ? readFileSync(file, "utf8") : "");
    return {
      ...result,
      output: result.stdout + result.stderr,
      summary: read(summary),
    };
  }

  function expectNoWarnings(result: ReturnType<typeof run>, status: number) {
    expect(result).toMatchObject({ status, summary: "" });
    expect(result.output).not.toContain("::warning");
  }

  it("keeps local strict lint failures unchanged, even when a local tool sets CI", () => {
    const result = run([violation("line_length")], { github: false });
    expectNoWarnings(result, 2);
  });

  it("reports numeric limits as CI warnings with repository-relative paths", () => {
    const result = run([violation("line_length")]);
    expect(result).toMatchObject({
      status: 0,
      output: expect.stringContaining(`::warning file=${fixtureFile},`),
      summary: expect.stringContaining("line_length"),
    });
  });

  it("retains strict correctness failures alongside advisory limits", () => {
    const result = run([violation("line_length"), violation("force_try")]);
    expect(result).toMatchObject({
      status: 2,
      output: expect.stringContaining("title=SwiftLint line_length"),
      stderr: expect.stringContaining("error: Fixture violation of force_try (force_try)"),
    });
    expect(result.summary).not.toContain("force_try");
  });

  it.each([
    ["type_name", "Type name"],
    ["generic_type_name", "Generic type name"],
  ] as const)("%s distinguishes length limits from invalid names", (rule, prefix) => {
    const length = violation(rule, `${prefix} 'A' should be between 2 and 60 characters long`);
    const invalid = `${prefix} 'Invalid_Name' should only contain alphanumeric and other allowed characters`;
    const mixed = run([length, violation(rule, invalid)]);
    expect(mixed.status, mixed.stderr).toBe(2);
    expect(mixed.output.match(/::warning /gu)).toHaveLength(1);
    expect(mixed.summary).toContain(length.reason);
    expect(mixed.stderr).toContain(`error: ${invalid} (${rule})`);
    expect(mixed.summary).not.toContain(invalid);
  });

  it.each([
    [JSON.stringify([violation("file_length")]), 1],
    ["not JSON", 0],
    [JSON.stringify([{ rule_id: "line_length" }]), 0],
  ] as const)("rejects tool failures and malformed reports: %s", (report, exit) => {
    expectNoWarnings(run(report, { exit }), 1);
  });
});
