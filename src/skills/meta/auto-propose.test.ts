import { describe, expect, it } from "vitest";
import { selectAutoProposeCandidates } from "./auto-propose.js";

describe("selectAutoProposeCandidates", () => {
  it("selects frequent low-risk workflow candidates", () => {
    const selected = selectAutoProposeCandidates([
      {
        key: "weekly-brief",
        count: 4,
        risk: "low",
        hasOpenProposal: false,
        triggerCollision: false,
      },
      {
        key: "dangerous-deploy",
        count: 5,
        risk: "high",
        hasOpenProposal: false,
        triggerCollision: false,
      },
      {
        key: "duplicate",
        count: 5,
        risk: "low",
        hasOpenProposal: true,
        triggerCollision: false,
      },
    ]);
    expect(selected.map((candidate) => candidate.key)).toEqual(["weekly-brief"]);
  });
});
