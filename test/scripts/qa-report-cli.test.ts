import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const repoRoot = path.resolve(__dirname, "../..");
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
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
    { cwd: repoRoot, encoding: "utf8" },
  );
}

it.each([
  ["coverage", "coverage"],
  ["parity", "parity-report"],
])("reports unknown QA %s options without a Node stack trace", (script, command) => {
  const result = runSourceScript(`scripts/qa-${script}-report.ts`, "--wat");
  expect(result).toMatchObject({ status: 1, stdout: "" });
  expect(result.stderr.trim()).toBe(`Unknown qa ${command} option: --wat`);
  expect(result.stderr).not.toMatch(/Node\.js|\n {4}at /u);
});

it("prints tool coverage without loading the QA execution runtime", () => {
  const result = runSourceScript("scripts/qa-coverage-report.ts", "--tools", "--json");

  expect(result.status, result.stderr).toBe(0);
  const report: { totalTools: number } = JSON.parse(result.stdout);
  expect(report).toMatchObject({ evaluated: false, pass: true });
  expect(report.totalTools).toBeGreaterThan(0);
});

it("writes failed parity artifacts without the execution runtime", async () => {
  const fixtureRoot = tempDirs.make("qa-report-cli-");
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
    ...Object.entries({
      "repo-root": fixtureRoot,
      "candidate-summary": "candidate.json",
      "baseline-summary": "baseline.json",
      "candidate-label": "candidate",
      "baseline-label": "baseline",
      "output-dir": "report",
    }).flatMap(([flag, value]) => [`--${flag}`, value]),
  );

  expect(result).toMatchObject({ stderr: "", status: 1 });
  expect(result.stdout).toContain("QA parity verdict: fail");
  const artifact = (name: string) =>
    fs.readFile(path.join(fixtureRoot, `report/qa-agentic-parity-${name}`), "utf8");
  const summary: { pass: boolean; scenarioComparisons: unknown[] } = JSON.parse(
    await artifact("summary.json"),
  );
  expect(summary.pass).toBe(false);
  expect(summary.scenarioComparisons).toContainEqual({
    name: "report-fixture",
    candidateStatus: "pass",
    baselineStatus: "fail",
  });
  expect(await artifact("report.md")).toContain("report-fixture");
});
