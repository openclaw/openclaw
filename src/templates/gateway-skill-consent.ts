import type {
  TemplateSkillAcknowledgement,
  TemplateSkillReview,
} from "../../packages/gateway-protocol/src/schema/templates.js";
import type { TemplateSkillInstallConsent } from "./packages.js";

export class TemplateSkillConsentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TemplateSkillConsentError";
  }
}

export function bindTemplateSkillWarningConsent(
  reviews: readonly TemplateSkillReview[],
  acknowledgements: readonly TemplateSkillAcknowledgement[] | undefined,
  assertCurrent: () => void,
  options: { directInstall?: boolean } = {},
): TemplateSkillInstallConsent | undefined {
  const firstWarning = reviews[0];
  if (options.directInstall && acknowledgements === undefined && firstWarning) {
    throw new TemplateSkillConsentError(
      `Skill ${firstWarning.ref} needs approval before this Template can be installed.`,
    );
  }
  const received = acknowledgements ?? [];
  if (reviews.length !== received.length) {
    throw new TemplateSkillConsentError("Review and acknowledge each skill trust warning again.");
  }
  const byActionId = new Map<string, TemplateSkillReview>();
  for (const review of reviews) {
    if (byActionId.has(review.actionId)) {
      throw new TemplateSkillConsentError("Duplicate skill trust review.");
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
      !entry.acknowledgeRiskWarning
    ) {
      throw new TemplateSkillConsentError("Skill trust state changed; review the Template again.");
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
        throw new TemplateSkillConsentError(
          "Skill trust state changed; review the Template again.",
        );
      }
    },
  };
}
