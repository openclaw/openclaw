import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const repoRoot = process.cwd();
const fixtureFile = "apps/ios/Sources/LimitFixture.swift";
const limitRules =
  "cyclomatic_complexity file_length function_body_length function_parameter_count large_tuple line_length nesting type_body_length".split(
    " ",
  );

function violation(rule: string) {
  return {
    file: path.join(repoRoot, fixtureFile),
    line: 7,
    character: 3,
    severity: "Error",
    rule_id: rule,
    reason: `Fixture violation of ${rule}`,
  };
}

describe.skipIf(process.platform === "win32")("SwiftLint limit policy", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);

  function run(report: unknown, { github = true, exit = 2, raw = false } = {}) {
    const fixtureDir = tempDirs.make("openclaw-swiftlint-");
    const summary = path.join(fixtureDir, "summary.md");
    const args = path.join(fixtureDir, "args.json");
    writeFileSync(
      path.join(fixtureDir, "swiftlint"),
      `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
writeFileSync(process.env.SWIFTLINT_TEST_ARGS, JSON.stringify(process.argv.slice(2)));
process.stdout.write(process.env.SWIFTLINT_TEST_REPORT);
process.exitCode = Number(process.env.SWIFTLINT_TEST_EXIT);
`,
      { mode: 0o755 },
    );
    const result = spawnSync(
      process.execPath,
      [path.join(repoRoot, "scripts/run-swiftlint.mts"), "--strict", "--config", ".swiftlint.yml"],
      {
        cwd: path.join(repoRoot, "apps/ios"),
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${fixtureDir}${path.delimiter}${process.env.PATH}`,
          CI: "true",
          GITHUB_ACTIONS: github ? "true" : undefined,
          GITHUB_STEP_SUMMARY: summary,
          SWIFTLINT_TEST_ARGS: args,
          SWIFTLINT_TEST_REPORT: raw ? String(report) : JSON.stringify(report),
          SWIFTLINT_TEST_EXIT: String(exit),
        },
      },
    );
    return {
      ...result,
      output: result.stdout + result.stderr,
      args: existsSync(args) ? (JSON.parse(readFileSync(args, "utf8")) as string[]) : [],
      summary: existsSync(summary) ? readFileSync(summary, "utf8") : "",
    };
  }

  function expectNoWarnings(result: ReturnType<typeof run>, status: number) {
    expect(result).toMatchObject({ status, summary: "" });
    expect(result.output).not.toContain("::warning");
  }

  it("keeps local strict lint failures unchanged, even when a local tool sets CI", () => {
    const result = run([violation("line_length")], { github: false });
    expectNoWarnings(result, 2);
    expect(result.args).toEqual(["lint", "--strict", "--config", ".swiftlint.yml"]);
  });

  it("reports all enabled numeric limit classes as CI warnings with repository-relative paths", () => {
    const result = run(limitRules.map((rule) => violation(rule)));
    expect(result.status, result.stderr).toBe(0);
    expect(result.args).toContain("--strict");
    expect(result.args.slice(-2)).toEqual(["--reporter", "json"]);
    expect(result.output).toContain(`::warning file=${fixtureFile},`);
    for (const rule of limitRules) {
      expect(result.output).toContain(`title=SwiftLint ${rule}`);
      expect(result.summary).toContain(rule);
    }
  });

  it("retains strict correctness failures alongside advisory limits", () => {
    const result = run([violation("line_length"), violation("force_try")]);
    expect(result.status).toBe(2);
    expect(result.output).toContain("title=SwiftLint line_length");
    expect(result.stderr).toContain("error: Fixture violation of force_try (force_try)");
    expect(result.summary).not.toContain("force_try");
  });

  it.each([
    ["type_name", "Type name", "A", 2, 60],
    ["generic_type_name", "Generic type name", "TTTTTTTTTTTTTTTTTTTTT", 1, 20],
  ] as const)(
    "%s warns only for length and keeps name characters and capitalization blocking",
    (rule, prefix, name, min, max) => {
      const length = {
        ...violation(rule),
        reason: `${prefix} '${name}' should be between ${min} and ${max} characters long`,
      };
      const invalidNames = [
        `${prefix} 'lowercase' should start with an uppercase character`,
        `${prefix} 'Invalid_Name' should only contain alphanumeric and other allowed characters`,
      ];
      const lengthOnly = run([length]);
      expect(lengthOnly.status, lengthOnly.stderr).toBe(0);
      expect(lengthOnly.output).toContain(`title=SwiftLint ${rule}`);
      expect(lengthOnly.summary).toContain(length.reason);

      const mixed = run([
        length,
        ...invalidNames.map((reason) => ({ ...violation(rule), reason })),
      ]);
      expect(mixed.status, mixed.stderr).toBe(2);
      expect(mixed.output.match(/::warning /gu)).toHaveLength(1);
      for (const reason of invalidNames) {
        expect(mixed.stderr).toContain(`error: ${reason} (${rule})`);
        expect(mixed.summary).not.toContain(reason);
      }
    },
  );

  it.each([
    { report: JSON.stringify([violation("file_length")]), exit: 1 },
    ...["not JSON", JSON.stringify([{ rule_id: "line_length" }])].map((report) => ({
      report,
      exit: 0,
    })),
  ])("rejects tool failures and malformed reports: $report", ({ report, exit }) => {
    const result = run(report, { exit, raw: true });
    expectNoWarnings(result, 1);
  });
});
