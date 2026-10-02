import { html, nothing } from "lit";
import type {
  ClawSkillAcknowledgement,
  ClawSkillReview,
} from "../../../../packages/gateway-protocol/src/schema/claws.js";
import { t } from "../../i18n/index.ts";
import { renderClawTrustWarning } from "./claws-trust-warning.ts";
import "../../styles/claws-plugin-review.css";

export type { ClawSkillAcknowledgement };

export function skillReviewKey(review: ClawSkillReview): string {
  return JSON.stringify([review.actionId, review.reviewToken]);
}

export function skillAcknowledgements(
  reviews: ClawSkillReview[] | undefined,
  acceptedWarnings: ReadonlySet<string>,
): ClawSkillAcknowledgement[] | null {
  if (!Array.isArray(reviews)) {
    return null;
  }
  const acknowledgements: ClawSkillAcknowledgement[] = [];
  for (const review of reviews) {
    if (
      !review.actionId ||
      !review.ref ||
      !review.version ||
      !review.integrity ||
      !review.riskWarning ||
      !review.reviewToken ||
      !acceptedWarnings.has(skillReviewKey(review))
    ) {
      return null;
    }
    acknowledgements.push({
      actionId: review.actionId,
      ref: review.ref,
      reviewToken: review.reviewToken,
      acknowledgeRiskWarning: true,
    });
  }
  return acknowledgements;
}

export function renderClawSkillReviews(params: {
  reviews: ClawSkillReview[];
  acceptedWarnings: ReadonlySet<string>;
  onRiskAcknowledged: (key: string, checked: boolean) => void;
}) {
  if (!params.reviews.length) {
    return nothing;
  }
  return html`<section class="claws-plugin-review" aria-label=${t("clawsSkillReview.title")}>
    <h4>${t("clawsSkillReview.title")}</h4>
    ${params.reviews.map((review) => {
      const key = skillReviewKey(review);
      return html`<div class="claws-plugin-review__entry">
        <div class="claws-plugin-review__heading">
          <strong>${review.ref}</strong>
          <span>${t("clawsCatalog.version", { version: review.version })}</span>
        </div>
        <p class="claws-plugin-review__source">${review.integrity}</p>
        ${renderClawTrustWarning(review.riskWarning)}
        <label class="claws-plugin-review__risk">
          <input
            type="checkbox"
            data-claw-skill-risk=${key}
            .checked=${params.acceptedWarnings.has(key)}
            @change=${(event: Event) => {
              const target = event.currentTarget;
              if (target instanceof HTMLInputElement) {
                params.onRiskAcknowledged(key, target.checked);
              }
            }}
          />
          ${t("clawsSkillReview.acknowledgeRisk")}
        </label>
      </div>`;
    })}
  </section>`;
}
