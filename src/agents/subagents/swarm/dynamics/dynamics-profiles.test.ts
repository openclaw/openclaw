import { describe, expect, it } from "vitest";
import { buildHandoffManifest } from "./dynamics-handoffs.js";
import { resolveDynamicsProfile } from "./dynamics-profiles.js";

describe("cognitive dynamics profiles", () => {
  it("resolves deterministic built-in profiles", () => {
    const first = resolveDynamicsProfile("independent-verifier");
    const second = resolveDynamicsProfile("independent-verifier");

    expect(first).toEqual(second);
    expect(first.contextBoundary).toBe("artifact-only");
    expect(first.mutationBudget).toBe(0);
    expect(first.verificationWeight).toBe(1);
    expect(first.digestInput).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("rejects unknown profiles instead of accepting arbitrary dynamics", () => {
    expect(() => resolveDynamicsProfile("skip-approval")).toThrow(
      "Unknown cognitive dynamics profile",
    );
  });

  it("resolves the deliberately small documented profile catalog", () => {
    for (const id of ["explorer", "builder", "critic", "independent-verifier", "glass-breaker"]) {
      expect(resolveDynamicsProfile(id).id).toBe(id);
    }
  });
});

describe("cognitive handoff boundaries", () => {
  const payload = {
    candidateDigest: "candidate:abc",
    artifactRefs: ["artifact:a"],
    evidenceRefs: ["evidence:e"],
    summary: "builder rationale",
  };

  it("keeps independent verifiers artifact-only", () => {
    expect(
      buildHandoffManifest({
        sourceReplicaId: "builder-1",
        targetReplicaId: "verifier-1",
        boundary: "artifact-only",
        payload,
      }),
    ).toEqual({
      version: 1,
      sourceReplicaId: "builder-1",
      targetReplicaId: "verifier-1",
      boundary: "artifact-only",
      candidateDigest: "candidate:abc",
      artifactRefs: ["artifact:a"],
      evidenceRefs: [],
    });
  });

  it("makes isolation structural at the manifest boundary", () => {
    const handoff = buildHandoffManifest({
      sourceReplicaId: "explorer-1",
      targetReplicaId: "explorer-2",
      boundary: "isolated",
      payload,
    });

    expect(handoff.candidateDigest).toBeUndefined();
    expect(handoff.artifactRefs).toEqual([]);
    expect(handoff.evidenceRefs).toEqual([]);
    expect(handoff.summary).toBeUndefined();
  });
});
