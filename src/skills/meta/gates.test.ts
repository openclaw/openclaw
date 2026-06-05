import { describe, expect, it } from "vitest";
import { recordMetaGateEvidence, summarizeMetaGateResults } from "./gates.js";
import type { MetaRunStore } from "./store.js";

describe("summarizeMetaGateResults", () => {
  it("marks all-passed gates as passed", () => {
    expect(
      summarizeMetaGateResults([
        { name: "lint", result: "passed" },
        { name: "runtime_e2e", result: "passed" },
      ]),
    ).toEqual({ result: "passed", evidence: "lint: passed\nruntime_e2e: passed" });
  });

  it("marks any failed gate as failed", () => {
    expect(
      summarizeMetaGateResults([
        { name: "lint", result: "passed" },
        { name: "runtime_e2e", result: "failed" },
      ]).result,
    ).toBe("failed");
  });

  it("includes gate summaries in evidence text", () => {
    expect(
      summarizeMetaGateResults([
        { name: "lint", result: "passed", summary: "no diagnostics" },
        { name: "runtime_e2e", result: "skipped" },
      ]),
    ).toEqual({
      result: "passed",
      evidence: "lint: passed - no diagnostics\nruntime_e2e: skipped",
    });
  });
});

describe("recordMetaGateEvidence", () => {
  it("records stable gate evidence rows through the meta run store", () => {
    const evidence: Parameters<MetaRunStore["recordEvidence"]>[0][] = [];

    recordMetaGateEvidence({
      store: {
        recordEvidence(params) {
          evidence.push(params);
        },
      },
      runId: "run-1",
      stepId: "proposal",
      proposalId: "proposal-1",
      createdAtMs: 1_000,
      createId: () => String(evidence.length + 1),
      results: [
        {
          name: "lint",
          result: "passed",
          summary: "clean",
          evidenceJson: { diagnostics: 0 },
        },
        {
          name: "runtime_e2e",
          result: "failed",
          riskLevel: "high",
          evidenceJson: { error: "missing tool" },
          artifactRefsJson: { log: "artifact://runtime-e2e/log" },
        },
      ],
    });

    expect(evidence).toEqual([
      {
        evidenceId: "gate-1",
        runId: "run-1",
        stepId: "proposal",
        proposalId: "proposal-1",
        gateName: "lint",
        result: "passed",
        evidenceJson: {
          result: "passed",
          summary: "clean",
          diagnostics: 0,
        },
        createdAtMs: 1_000,
      },
      {
        evidenceId: "gate-2",
        runId: "run-1",
        stepId: "proposal",
        proposalId: "proposal-1",
        gateName: "runtime_e2e",
        result: "failed",
        riskLevel: "high",
        evidenceJson: {
          result: "failed",
          error: "missing tool",
        },
        artifactRefsJson: { log: "artifact://runtime-e2e/log" },
        createdAtMs: 1_000,
      },
    ]);
  });
});
