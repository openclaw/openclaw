import { spawnSync } from "node:child_process";
// Maturity docs renderer tests cover evidence-backed generated-doc checks.
import fs from "node:fs";
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

function writeQaEvidence(params: {
  dir: string;
  entries: Array<{ id: string; status: "pass" | "fail" | "blocked" | "skipped" }>;
}) {
  fs.mkdirSync(params.dir, { recursive: true });
  fs.writeFileSync(
    path.join(params.dir, "qa-evidence.json"),
    `${JSON.stringify(
      {
        kind: "openclaw.qa.evidence-summary",
        schemaVersion: 2,
        generatedAt: "2026-06-23T00:00:00.000Z",
        evidenceMode: "full",
        profile: "all",
        entries: params.entries.map((entry) => ({
          test: {
            kind: "qa-scenario",
            id: entry.id,
            title: entry.id,
            source: { path: `qa/scenarios/${entry.id}.yaml` },
          },
          coverage: [{ id: "tools.evidence", role: "primary" }],
          result: { status: entry.status },
        })),
        scorecard: {
          filters: { surface: null, category: null },
          run: { evidenceEntryCount: params.entries.length },
          categories: {
            total: 0,
            fulfilled: 0,
            partial: 0,
            missing: 0,
            fulfillmentPercent: 0,
          },
          features: {
            total: 0,
            fulfilled: 0,
            partial: 0,
            missing: 0,
            fulfillmentPercent: 0,
          },
          coverageIds: {
            total: 0,
            fulfilled: 0,
            missing: 0,
            fulfillmentPercent: 0,
          },
          categoryReports: [],
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
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

  it("rejects scorecard evidence with failed or blocked entries", () => {
    const outputDir = tempDirs.make("openclaw-maturity-docs-output-");
    const evidenceDir = tempDirs.make("openclaw-maturity-docs-evidence-");
    writeQaEvidence({
      dir: evidenceDir,
      entries: [
        { id: "passing-scenario", status: "pass" },
        { id: "failing-scenario", status: "fail" },
        { id: "blocked-scenario", status: "blocked" },
      ],
    });

    const result = runCli(
      "--output-dir",
      outputDir,
      "--evidence-dir",
      evidenceDir,
      "--strict-inputs",
    );

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("maturity docs require passing QA evidence");
    expect(result.stderr).toContain("failing-scenario (fail)");
    expect(result.stderr).toContain("blocked-scenario (blocked)");
  });

  it("renders passing evidence without impossible failed or blocked result counts", () => {
    const outputDir = tempDirs.make("openclaw-maturity-docs-output-");
    const evidenceDir = tempDirs.make("openclaw-maturity-docs-evidence-");
    writeQaEvidence({
      dir: evidenceDir,
      entries: [
        { id: "passing-scenario", status: "pass" },
        { id: "skipped-scenario", status: "skipped" },
      ],
    });

    const result = runCli("--output-dir", outputDir, "--evidence-dir", evidenceDir);

    expect(result.status).toBe(0);
    const scorecard = fs.readFileSync(path.join(outputDir, "maturity", "scorecard.md"), "utf8");
    expect(scorecard).toContain("1 passed, 1 skipped");
    expect(scorecard).not.toContain("0 failed");
    expect(scorecard).not.toContain("0 blocked");
  });
});
