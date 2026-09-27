import { describe, expect, it } from "vitest";
import { candidateIdentity, type CandidateManifest } from "./candidate-evidence.js";

const candidate: CandidateManifest = {
  version: 1,
  candidateDigest: "candidate:a",
  sourceDigest: "source:a",
  recipeDigest: "recipe:a",
  policyDigest: "policy:a",
};

describe("exact candidate binding", () => {
  it("is stable for the same complete manifest", () => {
    expect(candidateIdentity(candidate)).toBe(candidateIdentity({ ...candidate }));
    expect(candidateIdentity(candidate)).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it.each(["candidateDigest", "sourceDigest", "recipeDigest", "policyDigest"] as const)(
    "changes when %s changes",
    (field) => {
      expect(candidateIdentity({ ...candidate, [field]: "changed" })).not.toBe(
        candidateIdentity(candidate),
      );
    },
  );

  it("rejects unsupported versions and missing identity fields", () => {
    expect(() => candidateIdentity({ ...candidate, version: 2 } as never)).toThrow(
      "unsupported candidate manifest version",
    );
    expect(() => candidateIdentity({ ...candidate, sourceDigest: "" })).toThrow("sourceDigest");
  });
});
