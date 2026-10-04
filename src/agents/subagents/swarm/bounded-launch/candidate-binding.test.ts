import { describe, expect, it } from "vitest";
import {
  candidateBindingIdentity,
  type BoundedLaunchCandidateBinding,
} from "./candidate-binding.js";

const binding: BoundedLaunchCandidateBinding = {
  version: 1,
  candidateDigest: "candidate:a",
  sourceDigest: "source:a",
  recipeDigest: "recipe:a",
  policyDigest: "policy:a",
};

describe("exact candidate binding", () => {
  it("is stable for the same complete binding", () => {
    expect(candidateBindingIdentity(binding)).toBe(candidateBindingIdentity({ ...binding }));
    expect(candidateBindingIdentity(binding)).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it.each(["candidateDigest", "sourceDigest", "recipeDigest", "policyDigest"] as const)(
    "changes when %s changes",
    (field) => {
      expect(candidateBindingIdentity({ ...binding, [field]: "changed" })).not.toBe(
        candidateBindingIdentity(binding),
      );
    },
  );

  it("rejects unsupported versions and missing identity fields", () => {
    expect(() => candidateBindingIdentity({ ...binding, version: 2 } as never)).toThrow(
      "unsupported candidate binding version",
    );
    expect(() => candidateBindingIdentity({ ...binding, sourceDigest: "" })).toThrow("sourceDigest");
  });
});
