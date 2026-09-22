import { describe, expect, it } from "vitest";
import { prepareDynamicsSpawn } from "./dynamics-spawn.js";

const base = {
  task: "Check the upload race",
  sourceReplicaId: "parent",
  targetReplicaId: "child",
};
const verifier = {
  boundary: "artifact-only",
  requirements: {
    sandbox: "require",
    candidateDigest: "required",
    artifactRefs: "required",
  },
  handoff: {
    candidateDigest: "candidate:a",
    artifactRefs: ["artifact:a"],
    evidenceRefs: ["other-reviewer-conclusion"],
    summary: "builder rationale",
  },
};

describe("native dynamics launch contract", () => {
  it("leaves calls without dynamics unchanged", () => {
    expect(prepareDynamicsSpawn({ ...base, dynamics: undefined })).toEqual({ task: base.task });
  });

  it("filters an artifact-only handoff and requests the existing sandbox owner", () => {
    const result = prepareDynamicsSpawn({ ...base, dynamics: verifier });
    expect(result.context).toBe("isolated");
    expect(result.sandbox).toBe("require");
    expect(result.task).toContain("artifact:a");
    expect(result.task).toContain("candidate:a");
    expect(result.task).not.toContain("builder rationale");
    expect(result.task).not.toContain("other-reviewer-conclusion");
    expect(result.task).toContain("grants no authority");
  });

  it("binds the generic contract and host-owned lineage into reproducible task bytes", () => {
    const first = prepareDynamicsSpawn({
      ...base,
      dynamics: { boundary: "isolated" },
    });
    expect(first).toEqual(prepareDynamicsSpawn({ ...base, dynamics: { boundary: "isolated" } }));
    expect(first.task).not.toBe(
      prepareDynamicsSpawn({ ...base, dynamics: { boundary: "summary-only" } }).task,
    );
    expect(first.task).not.toBe(
      prepareDynamicsSpawn({
        ...base,
        targetReplicaId: "replacement",
        dynamics: { boundary: "isolated" },
      }).task,
    );
  });

  it.each([
    null,
    [],
    { boundary: "constructor" },
    { boundary: "isolated", authority: "admin" },
    {
      boundary: "artifact-only",
      requirements: { artifactRefs: "required" },
    },
  ])("rejects invalid or incomplete configuration %j", (dynamics) => {
    expect(() => prepareDynamicsSpawn({ ...base, dynamics })).toThrow();
  });

  it("rejects requirements incompatible with the selected handoff boundary", () => {
    expect(() =>
      prepareDynamicsSpawn({
        ...base,
        dynamics: {
          boundary: "summary-only",
          requirements: { candidateDigest: "required" },
        },
      }),
    ).toThrow("drops candidate identity");
    expect(() =>
      prepareDynamicsSpawn({
        ...base,
        dynamics: {
          boundary: "evidence-only",
          requirements: { artifactRefs: "required" },
        },
      }),
    ).toThrow("drops artifacts");
  });

  it("bounds handoffs and snapshots their content before returning", () => {
    expect(() =>
      prepareDynamicsSpawn({
        ...base,
        dynamics: { boundary: "summary-only", handoff: { summary: "x".repeat(4097) } },
      }),
    ).toThrow();
    expect(() =>
      prepareDynamicsSpawn({
        ...base,
        dynamics: {
          boundary: "evidence-only",
          handoff: { evidenceRefs: Array(33).fill("ref") },
        },
      }),
    ).toThrow();
    const mutable = structuredClone(verifier);
    const prepared = prepareDynamicsSpawn({ ...base, dynamics: mutable });
    mutable.handoff.artifactRefs.push("late addition");
    expect(prepared.task).not.toContain("late addition");
  });
});
