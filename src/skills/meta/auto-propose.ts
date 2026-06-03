export type MetaAutoProposeCandidate = {
  key: string;
  count: number;
  risk: "low" | "medium" | "high";
  hasOpenProposal: boolean;
  triggerCollision: boolean;
};

export function selectAutoProposeCandidates(
  candidates: MetaAutoProposeCandidate[],
): MetaAutoProposeCandidate[] {
  return candidates
    .filter(
      (candidate) =>
        candidate.count >= 3 &&
        candidate.risk !== "high" &&
        !candidate.hasOpenProposal &&
        !candidate.triggerCollision,
    )
    .toSorted((left, right) => right.count - left.count || left.key.localeCompare(right.key));
}
