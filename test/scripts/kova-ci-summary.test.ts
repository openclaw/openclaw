// Kova Ci Summary tests cover kova ci summary script behavior.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function runSummary(report: unknown) {
  const root = mkdtempSync(join(tmpdir(), "openclaw-kova-summary-"));
  const reportPath = join(root, "report.json");
  const outputPath = join(root, "summary.md");
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  const result = spawnSync(
    process.execPath,
    ["scripts/kova-ci-summary.mjs", "--report", reportPath, "--output", outputPath],
    {
      cwd: process.cwd(),
      encoding: "utf8",
    },
  );
  let output = "";
  try {
    output = readFileSync(outputPath, "utf8");
  } catch {}
  rmSync(root, { force: true, recursive: true });
  return { output, result };
}

describe("scripts/kova-ci-summary", () => {
  it("prints help without treating --help as a valued option", () => {
    const result = spawnSync(process.execPath, ["scripts/kova-ci-summary.mjs", "--help"], {
      cwd: process.cwd(),
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("usage: node scripts/kova-ci-summary.mjs --report");
  });

  it("rejects empty Kova reports instead of rendering unknown summaries", () => {
    const empty = runSummary({});
    expect(empty.result.status).toBe(1);
    expect(empty.result.stderr).toContain("invalid Kova report: missing summary.statuses");

    const noEvidence = runSummary({ summary: { statuses: { pass: 1 } } });
    expect(noEvidence.result.status).toBe(1);
    expect(noEvidence.result.stderr).toContain(
      "invalid Kova report: missing records or performance groups",
    );
  });

  it("renders a Kova summary when status and evidence are present", () => {
    const { output, result } = runSummary({
      generatedAt: "2026-06-06T00:00:00.000Z",
      performance: {
        repeat: 1,
        groups: [
          {
            metrics: {
              timeToHealthReadyMs: {
                count: 1,
                max: 30,
                median: 20,
                p95: 30,
                title: "Health ready",
                unit: "ms",
              },
            },
            scenario: "gateway",
            state: "clean",
          },
        ],
      },
      records: [{ scenario: "gateway", state: "clean", status: "pass" }],
      runId: "run-1",
      summary: { statuses: { pass: 1 } },
      target: "main",
    });

    expect(result.status).toBe(0);
    expect(output).toContain("- Statuses: pass: 1");
    expect(output).toContain("| gateway | clean | Health ready | 20 ms | 30 ms | 30 ms |");
  });
});
