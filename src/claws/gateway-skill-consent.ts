import type {
  ClawSkillAcknowledgement,
  ClawSkillReview,
} from "../../packages/gateway-protocol/src/schema/claws.js";
import type { ClawSkillInstallConsent } from "./packages.js";

export class ClawSkillConsentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClawSkillConsentError";
  }
}

export function bindClawSkillWarningConsent(
  reviews: readonly ClawSkillReview[],
  acknowledgements: readonly ClawSkillAcknowledgement[] | undefined,
  assertCurrent: () => void,
): ClawSkillInstallConsent | undefined {
  const received = acknowledgements ?? [];
  if (reviews.length !== received.length) {
    throw new ClawSkillConsentError("Review and acknowledge each skill trust warning again.");
  }
  const byActionId = new Map<string, ClawSkillReview>();
  for (const review of reviews) {
    if (byActionId.has(review.actionId)) {
      throw new ClawSkillConsentError("Duplicate skill trust review.");
    }
    byActionId.set(review.actionId, review);
  }
  const acknowledged = new Set<string>();
  for (const entry of received) {
    const review = byActionId.get(entry.actionId);
    if (
      !review ||
      acknowledged.has(entry.actionId) ||
      entry.ref !== review.ref ||
      entry.reviewToken !== review.reviewToken ||
      entry.acknowledgeRiskWarning !== true
    ) {
      throw new ClawSkillConsentError("Skill trust state changed; review the Claw again.");
    }
    acknowledged.add(entry.actionId);
  }
  if (reviews.length === 0) {
    return undefined;
  }
  return {
    assertApproved: (pkg) => {
      assertCurrent();
      const review = byActionId.get(`skill:${pkg.ref}`);
      if (
        !review ||
        review.version !== pkg.version ||
        review.integrity !== pkg.integrity ||
        review.riskWarning !== pkg.riskWarning
      ) {
        throw new ClawSkillConsentError("Skill trust state changed; review the Claw again.");
      }
    },
  };
}
