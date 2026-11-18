import { describe, expect, it } from "vitest";
// @vitest-environment node
import { presentResult } from "../../e2e/activity-run-inspector.test-fixtures.ts";
import { classifyRunInspection, mergeDecisionPage } from "./run-inspector-model.ts";

it("classifies unknown evidence without assigning a stronger diagnostic", () => {
  expect(
    classifyRunInspection({
      schemaVersion: 1,
      run: { runId: "run-1", status: "unknown" },
      identity: {
        state: "unknown",
        reasonCode: "run_evidence_unreadable",
        missingEvidence: ["identity.context"],
        remediation: [],
      },
      decisionDisplays: [],
      coverage: { state: "unknown", missingEvidence: [] },
    }),
  ).toBe("unknown");
});

describe("receipt paging model", () => {
  const present = presentResult("run-1", "execution-1");

  it("merges only a page for the exact inspected execution and context", () => {
    const page = { ...present, nextDecisionCursor: "g:10:2" };
    expect(mergeDecisionPage(present, page)?.nextDecisionCursor).toBe("g:10:2");
    expect(
      mergeDecisionPage(present, {
        ...page,
        run: { ...page.run, executionId: "execution-2" },
      }),
    ).toBeNull();
  });
});
