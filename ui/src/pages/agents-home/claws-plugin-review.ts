import { html, nothing } from "lit";
import type { PluginOperatorGrants } from "../../../../packages/gateway-protocol/src/schema/plugins.js";
import type { PluginAcceptedDeclaredSurface } from "../../../../src/config/types.plugins.js";
import { t } from "../../i18n/index.ts";
import { renderClawTrustWarning } from "./claws-trust-warning.ts";
import "../../styles/claws-plugin-review.css";

export type ClawPluginReview = {
  actionId: string;
  pluginId: string;
  ref: string;
  version: string;
  ownerAction: "install" | "reuse";
  integrity: string;
  declaredCapabilities: PluginAcceptedDeclaredSurface;
  capabilityGrants: PluginOperatorGrants;
  capabilityGrantsByPluginId: Record<string, PluginOperatorGrants>;
  reviewToken: string;
  riskWarning?: string;
};

export type ClawPluginAcknowledgement = {
  actionId: string;
  pluginId: string;
  reviewToken: string;
  capabilityGrants: PluginOperatorGrants;
  capabilityGrantsByPluginId: Record<string, PluginOperatorGrants>;
  acknowledgeRiskWarning?: true;
};

function pluginReviewKey(review: ClawPluginReview): string {
  return JSON.stringify([review.actionId, review.pluginId]);
}

export function pluginAcknowledgements(
  reviews: ClawPluginReview[] | undefined,
  acceptedRiskWarnings: ReadonlySet<string>,
): ClawPluginAcknowledgement[] | null {
  if (!Array.isArray(reviews)) {
    return null;
  }
  const acknowledgements: ClawPluginAcknowledgement[] = [];
  for (const review of reviews) {
    if (!/^sha256-[A-Za-z0-9+/]{43}=$/.test(review.integrity)) {
      return null;
    }
    if (review.ownerAction === "reuse") {
      continue;
    }
    if (review.ownerAction !== "install") {
      return null;
    }
    if (
      !review.actionId ||
      !review.pluginId ||
      !review.ref ||
      !review.version ||
      !review.reviewToken ||
      !review.declaredCapabilities ||
      !review.capabilityGrants ||
      !review.capabilityGrantsByPluginId ||
      Object.keys(review.capabilityGrantsByPluginId).length === 0 ||
      (review.riskWarning && !acceptedRiskWarnings.has(pluginReviewKey(review)))
    ) {
      return null;
    }
    acknowledgements.push({
      actionId: review.actionId,
      pluginId: review.pluginId,
      reviewToken: review.reviewToken,
      capabilityGrants: review.capabilityGrants,
      capabilityGrantsByPluginId: review.capabilityGrantsByPluginId,
      ...(review.riskWarning ? { acknowledgeRiskWarning: true } : {}),
    });
  }
  return acknowledgements;
}

const DECLARED_GROUPS = [
  ["channels", "channels"],
  ["providers", "providers"],
  ["tools", "tools"],
  ["contracts", "contracts"],
  ["hooks", "hooks"],
  ["mcpServers", "mcpServers"],
  ["cliCommands", "cliCommands"],
  ["cliBackends", "cliBackends"],
  ["skills", "skills"],
  ["dangerousConfigFlags", "dangerousConfigFlags"],
] as const satisfies ReadonlyArray<
  readonly [keyof PluginAcceptedDeclaredSurface, keyof PluginAcceptedDeclaredSurface]
>;

function renderDeclaredCapabilities(declared: PluginAcceptedDeclaredSurface) {
  const rows = DECLARED_GROUPS.flatMap(([group, label]) => {
    const values = declared[group];
    return values?.length
      ? [
          html`<div class="claws-plugin-review__fact">
            <dt>${t(`clawsPluginReview.${label}`)}</dt>
            <dd>${values.join(", ")}</dd>
          </div>`,
        ]
      : [];
  });
  return html`<div class="claws-plugin-review__group">
    <h5>${t("clawsPluginReview.declared")}</h5>
    ${rows.length ? html`<dl>${rows}</dl>` : html`<p>${t("clawsPluginReview.noneDeclared")}</p>`}
  </div>`;
}

function renderGrant(label: string, allowed: boolean | undefined) {
  return allowed === undefined
    ? nothing
    : html`<div class="claws-plugin-review__fact">
        <dt>${label}</dt>
        <dd>${t(allowed ? "clawsPluginReview.allowed" : "clawsPluginReview.blocked")}</dd>
      </div>`;
}

function renderGrants(pluginId: string, grants: PluginOperatorGrants) {
  return html`<div class="claws-plugin-review__group">
    <h5>${t("clawsPluginReview.grants")} · ${pluginId}</h5>
    <dl>
      ${renderGrant(
        t("clawsPluginReview.promptInjection"),
        grants.hooks?.allowPromptInjection?.effective,
      )}
      ${renderGrant(
        t("clawsPluginReview.conversationAccess"),
        grants.hooks?.allowConversationAccess?.effective,
      )}
      ${renderGrant(t("clawsPluginReview.modelOverride"), grants.llm?.allowModelOverride)}
      ${renderGrant(t("clawsPluginReview.authProfileOverride"), grants.llm?.allowAuthProfileOverride)}
      ${renderGrant(t("clawsPluginReview.agentOverride"), grants.llm?.allowAgentIdOverride)}
      ${renderGrant(t("clawsPluginReview.subagentModelOverride"), grants.subagent?.allowModelOverride)}
      ${
        grants.llm?.allowedModels?.length
          ? html`<div class="claws-plugin-review__fact">
              <dt>${t("clawsPluginReview.allowedModels")}</dt>
              <dd>${grants.llm.allowedModels.join(", ")}</dd>
            </div>`
          : nothing
      }
      ${
        grants.llm?.allowedCompletionModels?.length
          ? html`<div class="claws-plugin-review__fact">
              <dt>${t("clawsPluginReview.completionModels")}</dt>
              <dd>${grants.llm.allowedCompletionModels.join(", ")}</dd>
            </div>`
          : nothing
      }
      ${
        grants.subagent?.allowedModels?.length
          ? html`<div class="claws-plugin-review__fact">
              <dt>${t("clawsPluginReview.subagentModels")}</dt>
              <dd>${grants.subagent.allowedModels.join(", ")}</dd>
            </div>`
          : nothing
      }
    </dl>
  </div>`;
}

export function renderClawPluginReviews(params: {
  reviews: ClawPluginReview[];
  acceptedRiskWarnings: ReadonlySet<string>;
  onRiskAcknowledged: (key: string, checked: boolean) => void;
}) {
  if (!params.reviews.length) {
    return nothing;
  }
  return html`<section class="claws-plugin-review" aria-label=${t("clawsPluginReview.title")}>
    <h4>${t("clawsPluginReview.title")}</h4>
    ${params.reviews.map((review) => {
      const key = pluginReviewKey(review);
      return html`<div class="claws-plugin-review__entry">
        <div class="claws-plugin-review__heading">
          <strong>${review.pluginId}</strong>
          <span
            >${
              review.ownerAction === "install"
                ? t("clawsPluginReview.install")
                : t("clawsPluginReview.reuse")
            }</span
          >
        </div>
        <p class="claws-plugin-review__source">${review.ref} · ${review.version}</p>
        <dl>
          <div class="claws-plugin-review__fact">
            <dt>${t("clawsPluginReview.integrity")}</dt>
            <dd><code>${review.integrity}</code></dd>
          </div>
        </dl>
        ${renderDeclaredCapabilities(review.declaredCapabilities)}
        ${Object.entries(review.capabilityGrantsByPluginId)
          .toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([pluginId, grants]) => renderGrants(pluginId, grants))}
        ${review.riskWarning ? renderClawTrustWarning(review.riskWarning) : nothing}
        ${
          review.ownerAction === "install" && review.riskWarning
            ? html`<label class="claws-plugin-review__risk">
                <input
                  type="checkbox"
                  data-claw-plugin-risk=${key}
                  .checked=${params.acceptedRiskWarnings.has(key)}
                  @change=${(event: Event) => {
                    const target = event.currentTarget;
                    if (target instanceof HTMLInputElement) {
                      params.onRiskAcknowledged(key, target.checked);
                    }
                  }}
                />
                ${t("clawsPluginReview.acknowledgeRisk")}
              </label>`
            : nothing
        }
      </div>`;
    })}
  </section>`;
}
