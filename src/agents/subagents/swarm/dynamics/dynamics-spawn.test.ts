import { describe, expect, it } from "vitest";
import { prepareBoundedLaunch } from "./dynamics-spawn.js";

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

describe("native bounded launch preparation", () => {
  it("leaves calls without bounded launch unchanged", () => {
    expect(prepareBoundedLaunch({ ...base, boundedLaunch: undefined })).toEqual({ task: base.task });
  });

  it("filters an artifact-only handoff and requests the existing sandbox owner", () => {
    const result = prepareBoundedLaunch({ ...base, boundedLaunch: verifier });
    expect(result.context).toBe("isolated");
    expect(result.sandbox).toBe("require");
    expect(result.task).toContain("artifact:a");
    expect(result.task).toContain("candidate:a");
    expect(result.task).not.toContain("builder rationale");
    expect(result.task).not.toContain("other-reviewer-conclusion");
    expect(result.task).toContain("grants no authority");
  });

  it.each([
    ["isolated", [], ["candidate:matrix", "artifact:matrix", "evidence:matrix", "summary:matrix"]],
    [
      "artifact-only",
      ["candidate:matrix", "artifact:matrix"],
      ["evidence:matrix", "summary:matrix"],
    ],
    [
      "evidence-only",
      ["candidate:matrix", "evidence:matrix"],
      ["artifact:matrix", "summary:matrix"],
    ],
    ["summary-only", ["summary:matrix"], ["candidate:matrix", "artifact:matrix", "evidence:matrix"]],
  ] as const)("projects %s handoff to only its allowed information class", (boundary, kept, dropped) => {
    const result = prepareBoundedLaunch({
      ...base,
      boundedLaunch: {
        boundary,
        handoff: {
          candidateDigest: "candidate:matrix",
          artifactRefs: ["artifact:matrix"],
          evidenceRefs: ["evidence:matrix"],
          summary: "summary:matrix",
        },
      },
    });
    for (const value of kept) {
      expect(result.task).toContain(value);
    }
    for (const value of dropped) {
      expect(result.task).not.toContain(value);
    }
  });

  it("binds the generic contract and host-owned lineage into reproducible task bytes", () => {
    const first = prepareBoundedLaunch({ ...base, boundedLaunch: { boundary: "isolated" } });
    expect(first).toEqual(prepareBoundedLaunch({ ...base, boundedLaunch: { boundary: "isolated" } }));
    expect(first.task).not.toBe(
      prepareBoundedLaunch({ ...base, boundedLaunch: { boundary: "summary-only" } }).task,
    );
    expect(first.task).not.toBe(
      prepareBoundedLaunch({
        ...base,
        targetReplicaId: "replacement",
        boundedLaunch: { boundary: "isolated" },
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
  ])("rejects invalid or incomplete configuration %j", (boundedLaunch) => {
    expect(() => prepareBoundedLaunch({ ...base, boundedLaunch })).toThrow();
  });

  it("rejects requirements incompatible with the selected boundary", () => {
    expect(() =>
      prepareBoundedLaunch({
        ...base,
        boundedLaunch: {
          boundary: "summary-only",
          requirements: { candidateDigest: "required" },
        },
      }),
    ).toThrow("drops candidate identity");
  });

  it("binds the complete candidate manifest before fingerprinting", () => {
    const candidate = {
      version: 1 as const,
      candidateDigest: "candidate:a",
      sourceDigest: "source:a",
      recipeDigest: "recipe:a",
      policyDigest: "policy:a",
    };
    const first = prepareBoundedLaunch({
      ...base,
      boundedLaunch: {
        ...verifier,
        candidate,
      },
    });
    expect(first.task).toContain("Exact candidate binding");
    expect(first.task).not.toBe(
      prepareBoundedLaunch({
        ...base,
        boundedLaunch: {
          ...verifier,
          candidate: { ...candidate, policyDigest: "policy:b" },
        },
      }).task,
    );
    expect(() =>
      prepareBoundedLaunch({
        ...base,
        boundedLaunch: {
          ...verifier,
          handoff: { candidateDigest: "candidate:b", artifactRefs: ["artifact:a"] },
          candidate,
        },
      }),
    ).toThrow("does not match candidate manifest");
  });

  it("bounds handoffs and snapshots their content before returning", () => {
    expect(() =>
      prepareBoundedLaunch({
        ...base,
        boundedLaunch: { boundary: "summary-only", handoff: { summary: "x".repeat(4097) } },
      }),
    ).toThrow();
    expect(() =>
      prepareBoundedLaunch({
        ...base,
        boundedLaunch: {
          boundary: "evidence-only",
          handoff: { evidenceRefs: Array(33).fill("ref") },
        },
      }),
    ).toThrow();
    const mutable = structuredClone(verifier);
    const prepared = prepareBoundedLaunch({ ...base, boundedLaunch: mutable });
    mutable.handoff.artifactRefs.push("late addition");
    expect(prepared.task).not.toContain("late addition");
  });
});
