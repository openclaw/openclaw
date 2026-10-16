import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(__dirname, "../..");
// Release reports must still work when the execution runtime is unavailable.
const withoutExecutionRuntime = `data:text/javascript,${encodeURIComponent(`
  import { registerHooks } from "node:module";
  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier.endsWith("/qa-lab/src/cli.runtime.ts")) {
        throw new Error("QA execution runtime is unavailable");
      }
      return nextResolve(specifier, context);
    },
  });
`)}`;

function runSourceScript(scriptPath: string, ...args: string[]) {
  return spawnSync(
    process.execPath,
    ["--import", withoutExecutionRuntime, "--import", "tsx", scriptPath, ...args],
    {
      cwd: repoRoot,
      encoding: "utf8",
    },
  );
}

function expectNoNodeStack(stderr: string) {
  expect(stderr).not.toContain("Node.js");
  expect(stderr).not.toContain("\n    at ");
}

describe("QA report source CLIs", () => {
  it("reports unknown QA coverage options without a Node stack trace", () => {
    const result = runSourceScript("scripts/qa-coverage-report.ts", "--wat");

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr.trim()).toBe("Unknown qa coverage option: --wat");
    expectNoNodeStack(result.stderr);
  });

  it("reports unknown QA parity options without a Node stack trace", () => {
    const result = runSourceScript("scripts/qa-parity-report.ts", "--wat");

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr.trim()).toBe("Unknown qa parity-report option: --wat");
    expectNoNodeStack(result.stderr);
  });

  it("prints tool coverage without loading the QA execution runtime", () => {
    const result = runSourceScript("scripts/qa-coverage-report.ts", "--tools", "--json");

    expect(result.status, result.stderr).toBe(0);
    const report = JSON.parse(result.stdout) as {
      evaluated: boolean;
      pass: boolean;
      totalTools: number;
    };
    expect(report).toMatchObject({ evaluated: false, pass: true });
    expect(report.totalTools).toBeGreaterThan(0);
  });

  it("writes parity artifacts and preserves a failed verdict without the execution runtime", async () => {
    const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "qa-report-cli-"));
    try {
      for (const [label, status] of [
        ["candidate", "pass"],
        ["baseline", "fail"],
      ]) {
        await fs.writeFile(
          path.join(fixtureRoot, `${label}.json`),
          JSON.stringify({
            run: { status: "completed" },
            scenarios: [{ name: "report-fixture", status, steps: [] }],
          }),
        );
      }
      const result = runSourceScript(
        "scripts/qa-parity-report.ts",
        "--repo-root",
        fixtureRoot,
        "--candidate-summary",
        "candidate.json",
        "--baseline-summary",
        "baseline.json",
        "--candidate-label",
        "candidate",
        "--baseline-label",
        "baseline",
        "--output-dir",
        "report",
      );

      expect(result.stderr).toBe("");
      expect(result.status).toBe(1);
      expect(result.stdout).toContain("QA parity verdict: fail");
      const summary = JSON.parse(
        await fs.readFile(path.join(fixtureRoot, "report/qa-agentic-parity-summary.json"), "utf8"),
      ) as { pass: boolean; scenarioComparisons: unknown[] };
      expect(summary.pass).toBe(false);
      expect(summary.scenarioComparisons).toContainEqual({
        name: "report-fixture",
        candidateStatus: "pass",
        baselineStatus: "fail",
      });
      expect(
        await fs.readFile(path.join(fixtureRoot, "report/qa-agentic-parity-report.md"), "utf8"),
      ).toContain("report-fixture");
    } finally {
      await fs.rm(fixtureRoot, { recursive: true, force: true });
    }
  });
});
