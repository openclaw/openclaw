import assert from "node:assert/strict";
import { describe, expect, it } from "vitest";
import { planAdaptiveSelection } from "../../scripts/lib/ci-adaptive-selection.mjs";

const context = {
  repository: "example/project",
  revision: "a".repeat(40),
  tree: "b".repeat(40),
  configDigest: "c".repeat(64),
  lockDigest: "d".repeat(64),
  environmentDigest: "e".repeat(64),
};
const files = ["a", "b"].map((name) => ({
  file: `src/${name}.test.ts`,
  project: "unit",
  pool: "forks",
}));
function inputs() {
  return {
    observations: {
      version: 1,
      context,
      invocations: [
        {
          complete: true,
          files: files.map((file, index) => ({
            ...file,
            complete: true,
            outcome: "passed",
            dependencies: [file.file, `src/${index === 0 ? "a" : "b"}.ts`] as string[] | null,
          })),
        },
      ],
    },
    request: {
      version: 1,
      context: { ...context, revision: "f".repeat(40) },
      baselineRevision: context.revision,
      baselineTree: context.tree,
      files,
      changedFiles: ["src/a.ts"],
      audit: false,
    },
  };
}

describe("adaptive shadow selection", () => {
  it("explains dependency selection while preserving the full execution set", () => {
    const { observations, request } = inputs();
    const plan = planAdaptiveSelection(observations, request);
    expect(plan.scheduledFiles).toEqual(files);
    expect(plan.candidateFiles).toEqual([{ ...files[0], reasons: ["dependency-change"] }]);
    expect(plan.candidateOmittedCount).toBe(1);
  });

  it.each(["incompatible", "baseline", "global", "unmapped", "audit"])(
    "falls back for %s",
    (reason) => {
      const { observations, request } = inputs();
      if (reason === "incompatible") {
        request.context.lockDigest = "f".repeat(64);
      }
      if (reason === "baseline") {
        request.baselineRevision = "f".repeat(40);
      }
      if (reason === "global") {
        request.changedFiles = ["scripts/test.mjs"];
      }
      if (reason === "unmapped") {
        request.changedFiles = ["src/new.ts"];
      }
      if (reason === "audit") {
        request.audit = true;
      }
      const plan = planAdaptiveSelection(observations, request);
      expect(plan.fallbackReasons.length).toBeGreaterThan(0);
      expect(plan.candidateCount).toBe(files.length);
    },
  );

  it.each(["missing", "failed", "partial", "dependencies"])(
    "retains tests with %s evidence",
    (reason) => {
      const { observations, request } = inputs();
      const invocation = observations.invocations[0];
      assert(invocation);
      const rows = invocation.files;
      const second = rows[1];
      assert(second);
      if (reason === "missing") {
        rows.pop();
      }
      if (reason === "failed") {
        second.outcome = "failed";
      }
      if (reason === "partial") {
        invocation.complete = false;
      }
      if (reason === "dependencies") {
        second.dependencies = null;
      }
      expect(planAdaptiveSelection(observations, request).candidateCount).toBe(2);
    },
  );

  it("model recommendations can only add tests and must match the current source", () => {
    const { observations, request } = inputs();
    const recommendation = { version: 1, context: request.context, selectedFiles: [files[1]] };
    expect(planAdaptiveSelection(observations, request, recommendation).candidateCount).toBe(2);
    recommendation.context = context;
    expect(() => planAdaptiveSelection(observations, request, recommendation)).toThrow(
      "Stale model",
    );
    expect(
      planAdaptiveSelection(observations, request, {
        ...recommendation,
        context: request.context,
        selectedFiles: [],
      }).candidateCount,
    ).toBe(1);
  });
});
