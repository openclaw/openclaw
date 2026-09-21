import { describe, expect, it } from "vitest";
import { prepareDynamicsSpawn } from "./dynamics-spawn.js";

const base = {
  task: "Check the upload race",
  sourceReplicaId: "parent",
  targetReplicaId: "child",
};
const verifier = {
  profile: "independent-verifier",
  handoff: {
    candidateDigest: "candidate:a",
    artifactRefs: ["artifact:a"],
    evidenceRefs: ["other-reviewer-conclusion"],
    summary: "builder rationale",
  },
};

describe("native dynamics spawn preparation", () => {
  it("leaves calls without dynamics unchanged", () => {
    expect(prepareDynamicsSpawn({ ...base, dynamics: undefined })).toEqual({ task: base.task });
  });

  it("filters the explicit verifier handoff and requires the existing sandbox owner", () => {
    const result = prepareDynamicsSpawn({ ...base, dynamics: verifier });
    expect(result.context).toBe("isolated");
    expect(result.sandbox).toBe("require");
    expect(result.task).toContain("artifact:a");
    expect(result.task).toContain("candidate:a");
    expect(result.task).not.toContain("builder rationale");
    expect(result.task).not.toContain("other-reviewer-conclusion");
    expect(result.task).toContain("not tool permissions or evidence of independence");
  });

  it("binds resolved profile and host-owned lineage into reproducible task bytes", () => {
    const first = prepareDynamicsSpawn({ ...base, dynamics: { profile: "explorer" } });
    expect(first).toEqual(prepareDynamicsSpawn({ ...base, dynamics: { profile: "explorer" } }));
    expect(first.task).not.toBe(
      prepareDynamicsSpawn({ ...base, dynamics: { profile: "builder" } }).task,
    );
    expect(first.task).not.toBe(
      prepareDynamicsSpawn({
        ...base,
        targetReplicaId: "replacement",
        dynamics: { profile: "explorer" },
      }).task,
    );
  });

  it.each([
    null,
    [],
    { profile: "constructor" },
    { profile: "explorer", authority: "admin" },
    { profile: "independent-verifier" },
  ])("rejects invalid or misleading configuration %j", (dynamics) => {
    expect(() => prepareDynamicsSpawn({ ...base, dynamics })).toThrow();
  });

  it("bounds handoffs and snapshots their content before returning", () => {
    expect(() =>
      prepareDynamicsSpawn({
        ...base,
        dynamics: { profile: "builder", handoff: { summary: "x".repeat(4097) } },
      }),
    ).toThrow();
    expect(() =>
      prepareDynamicsSpawn({
        ...base,
        dynamics: {
          profile: "critic",
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
