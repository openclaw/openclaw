// Maturity docs renderer tests cover evidence-backed generated-doc checks.
import { spawnSync } from "node:child_process";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTempDirTracker } from "../helpers/temp-dir.js";

const repoRoot = path.resolve(__dirname, "../..");
const tempDirs = createTempDirTracker();

afterEach(() => {
  tempDirs.cleanup();
});

function runCli(...args: string[]) {
  return spawnSync(
    process.execPath,
    ["--import", "tsx", "scripts/qa/render-maturity-docs.ts", ...args],
    {
      cwd: repoRoot,
      encoding: "utf8",
    },
  );
}

describe("maturity docs renderer CLI", () => {
  it("checks maturity inputs without requiring QA evidence artifacts", () => {
    const result = runCli("--check");

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("maturity docs inputs are valid in docs");
    expect(result.stdout).toContain("evidence-backed freshness check skipped");
  });

  it("still requires QA evidence artifacts when rendering generated docs", () => {
    const outputDir = tempDirs.make("openclaw-maturity-docs-test-");
    const result = runCli("--output-dir", outputDir);

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(
      "maturity scorecard rendering requires all or release profile qa-evidence.json",
    );
  });
});
