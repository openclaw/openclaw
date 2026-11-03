import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  adaptiveCostMarkdown,
  estimateAdaptiveCosts,
} from "../../scripts/lib/ci-adaptive-costs.mjs";

const noModel = { inputTokens: 0, outputTokens: 0, inputUsdPerMillion: 0, outputUsdPerMillion: 0 };
function scenario() {
  return {
    version: 1,
    mode: "projection",
    jobs: [
      {
        id: "run/job/attempt-1",
        baselineSeconds: 100,
        selectableSeconds: 80,
        retainedFraction: 0.25,
        auditRate: 0.1,
        overheadSeconds: 5,
        auditOverheadSeconds: 2,
        dropEmptyJob: false,
        usdPerMinute: 0.012 as number | null,
        billingQuantumSeconds: 60,
        allocatedVcpus: 4 as number | null,
      },
    ],
    modelUsage: {
      baseline: noModel,
      candidate: {
        inputTokens: 10_000,
        outputTokens: 100,
        inputUsdPerMillion: 0.042,
        outputUsdPerMillion: 0,
      },
    },
  };
}

describe("adaptive CI cost model", () => {
  it("charges setup, audits, overhead, billing rounding and model input", () => {
    const report = estimateAdaptiveCosts(scenario());
    expect(report.runnerSeconds.candidate).toBeCloseTo(51.2);
    expect(report.runnerSeconds.saved).toBeCloseTo(48.8);
    expect(report.runnerListUsd.candidate).toBeCloseTo(0.0132);
    expect(report.modelListUsd.candidate).toBeCloseTo(0.00042);
    expect(report.netListUsdSaved).toBeCloseTo(0.01038);
    expect(report.modelTokens.inputSaved).toBe(-10_000);
    expect(report.criticalPathSecondsSaved).toBeNull();
  });

  it("rounds full-audit and selected executions before averaging", () => {
    const input = scenario();
    const [job] = input.jobs;
    assert(job);
    Object.assign(job, {
      baselineSeconds: 121,
      selectableSeconds: 120,
      retainedFraction: 0.5,
      auditRate: 0.5,
      overheadSeconds: 0,
      auditOverheadSeconds: 0,
    });
    const report = estimateAdaptiveCosts(input);
    expect(report.runnerSeconds.candidate).toBe(91);
    expect(report.runnerListUsd.candidate).toBeCloseTo(0.03);
  });

  it("shadow collection adds overhead and realizes no test savings", () => {
    const input = scenario();
    input.mode = "shadow";
    const report = estimateAdaptiveCosts(input);
    expect(report.runnerSeconds.saved).toBe(-5);
    expect(report.netListUsdSaved).toBeCloseTo(-0.00042);
  });

  it("retains fixed setup unless empty-job elimination is explicit", () => {
    const input = scenario();
    const [job] = input.jobs;
    assert(job);
    Object.assign(job, { retainedFraction: 0, auditRate: 0, overheadSeconds: 0 });
    expect(estimateAdaptiveCosts(input).runnerSeconds.candidate).toBe(20);
    job.dropEmptyJob = true;
    expect(estimateAdaptiveCosts(input).runnerSeconds.candidate).toBe(0);
  });

  it("keeps unknown price and CPU allocation out of zero-valued totals", () => {
    const input = scenario();
    const [job] = input.jobs;
    assert(job);
    job.usdPerMinute = null;
    job.allocatedVcpus = null;
    const report = estimateAdaptiveCosts(input);
    expect(report.runnerListUsd.saved).toBeNull();
    expect(report.allocatedVcpuMinutes.saved).toBeNull();
    expect(report.netListUsdSaved).toBeNull();
    expect(adaptiveCostMarkdown(report)).toContain("unknown");
  });

  it("rejects impossible or double-counted job observations", () => {
    const input = scenario();
    const [job] = input.jobs;
    assert(job);
    input.jobs.push(job);
    expect(() => estimateAdaptiveCosts(input)).toThrow("duplicate job");
    input.jobs.pop();
    job.selectableSeconds = 101;
    expect(() => estimateAdaptiveCosts(input)).toThrow("exceeds job");
  });

  it("writes both operator report formats from the CLI", () => {
    const root = mkdtempSync(path.join(tmpdir(), "ci-costs-"));
    try {
      const input = path.join(root, "input.json");
      const output = path.join(root, "output.json");
      const markdown = path.join(root, "output.md");
      writeFileSync(input, JSON.stringify(scenario()));
      const result = spawnSync(
        process.execPath,
        [
          "scripts/ci-adaptive-costs.mjs",
          "--input",
          input,
          "--output",
          output,
          "--markdown",
          markdown,
        ],
        { encoding: "utf8" },
      );
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(readFileSync(output, "utf8")).runnerSeconds.saved).toBeCloseTo(48.8);
      expect(readFileSync(markdown, "utf8")).toContain("Critical-path latency saved: unknown");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
