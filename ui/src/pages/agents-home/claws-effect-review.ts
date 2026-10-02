import { html, nothing } from "lit";
import { Value } from "typebox/value";
import {
  ClawActionEffectSchema,
  type ClawActionEffect,
  type ClawLifecyclePlanResult,
} from "../../../../packages/gateway-protocol/src/schema/claws.js";
import { t } from "../../i18n/index.ts";
import "../../styles/claws-effect-review.css";

export function hasCompleteClawActionEffects(
  plan: Pick<ClawLifecyclePlanResult, "operation" | "actions"> | null | undefined,
): boolean {
  if (!plan) {
    return false;
  }
  return plan.actions.every((action) => {
    if (action.blocked) {
      return true;
    }
    const effect = action.effect;
    if (action.kind === "workspaceFile" || action.kind === "bootstrap") {
      return (
        effect?.type === "workspace-file" &&
        Value.Check(ClawActionEffectSchema, effect) &&
        (plan.operation !== "add" || Boolean(effect.source && effect.desiredDigest)) &&
        (plan.operation !== "remove" || Boolean(effect.currentDigest)) &&
        (plan.operation !== "update" || Boolean(effect.currentDigest || effect.desiredDigest))
      );
    }
    if (action.kind === "mcpServer") {
      return (
        effect?.type === "mcp-server" &&
        Value.Check(ClawActionEffectSchema, effect) &&
        (plan.operation !== "add" || Boolean(effect.proposed && effect.desiredDigest)) &&
        (plan.operation !== "remove" || Boolean(effect.currentDigest && effect.ownership)) &&
        (plan.operation !== "update" || Boolean(effect.currentDigest || effect.desiredDigest))
      );
    }
    if (action.kind === "package" && action.id.startsWith("skill:")) {
      if (effect?.type !== "skill-package" || !Value.Check(ClawActionEffectSchema, effect)) {
        return false;
      }
      const artifact =
        plan.operation === "update" && action.action === "release"
          ? effect.current
          : effect.desired;
      return Boolean(artifact && action.id === `skill:${artifact.ref}`);
    }
    if (plan.operation === "remove" && action.kind === "packageRef") {
      if (action.id.startsWith("skill:")) {
        return (
          effect?.type === "skill-package" &&
          Value.Check(ClawActionEffectSchema, effect) &&
          Boolean(
            effect.current &&
            effect.ownership &&
            action.id === `skill:${effect.current.ref}@${effect.current.version}`,
          )
        );
      }
      return effect?.type === "ownership" && Value.Check(ClawActionEffectSchema, effect);
    }
    return true;
  });
}

function fact(label: string, value: string | number | undefined) {
  return value === undefined || value === ""
    ? nothing
    : html`<div class="claws-effect-review__fact">
        <dt>${label}</dt>
        <dd>${value}</dd>
      </div>`;
}

function ownership(effect: {
  relationship: "managed" | "referenced";
  origin: "claw-introduced" | "pre-existing";
  independentOwner: boolean;
  affectedClawCount: number;
}) {
  return html`
    ${fact(t("clawsEffectReview.relationship"), t(effect.relationship === "managed" ? "clawsEffectReview.managed" : "clawsEffectReview.referenced"))}
    ${fact(t("clawsEffectReview.origin"), t(effect.origin === "pre-existing" ? "clawsEffectReview.preExisting" : "clawsEffectReview.clawIntroduced"))}
    ${fact(t("clawsEffectReview.independentOwner"), effect.independentOwner ? t("clawsAccessReview.yes") : t("clawsAccessReview.no"))}
    ${fact(t("clawsEffectReview.otherClaws"), effect.affectedClawCount)}
  `;
}

export function renderClawActionEffect(effect: ClawActionEffect | undefined) {
  if (!effect) {
    return nothing;
  }
  if (effect.type === "workspace-file") {
    return html`<dl class="claws-effect-review">
      ${fact(t("clawsEffectReview.destination"), effect.destination)}
      ${fact(t("clawsEffectReview.source"), effect.source)}
      ${fact(t("clawsEffectReview.currentDigest"), effect.currentDigest)}
      ${fact(t("clawsEffectReview.desiredDigest"), effect.desiredDigest)}
      ${effect.currentPresent === undefined ? nothing : fact(t("clawsEffectReview.currentPresent"), effect.currentPresent ? t("clawsAccessReview.yes") : t("clawsAccessReview.no"))}
    </dl>`;
  }
  if (effect.type === "ownership") {
    return html`<dl class="claws-effect-review">${ownership(effect)}</dl>`;
  }
  if (effect.type === "skill-package") {
    return html`<dl class="claws-effect-review">
      ${
        effect.current
          ? fact(
              t("clawsEffectReview.currentPackage"),
              `${effect.current.source}:${effect.current.ref}@${effect.current.version}`,
            )
          : nothing
      }
      ${
        effect.current
          ? fact(t("clawsEffectReview.currentArtifact"), effect.current.integrity)
          : nothing
      }
      ${
        effect.desired
          ? fact(
              t("clawsEffectReview.newPackage"),
              `${effect.desired.source}:${effect.desired.ref}@${effect.desired.version}`,
            )
          : nothing
      }
      ${
        effect.desired
          ? fact(t("clawsEffectReview.newArtifact"), effect.desired.integrity)
          : nothing
      }
      ${effect.ownership ? ownership(effect.ownership) : nothing}
    </dl>`;
  }
  const proposed = effect.proposed;
  return html`<dl class="claws-effect-review">
    ${fact(t("clawsEffectReview.currentDigest"), effect.currentDigest)}
    ${fact(t("clawsEffectReview.desiredDigest"), effect.desiredDigest)}
    ${proposed ? fact(t("clawsEffectReview.transport"), proposed.transport) : nothing}
    ${proposed ? fact(t("clawsEffectReview.command"), proposed.command) : nothing}
    ${proposed?.arguments?.length ? fact(t("clawsEffectReview.arguments"), JSON.stringify(proposed.arguments)) : nothing}
    ${proposed ? fact(t("clawsEffectReview.url"), proposed.url) : nothing}
    ${proposed ? fact(t("clawsEffectReview.urlDigest"), proposed.urlDigest) : nothing}
    ${proposed?.queryParameterNames?.length ? fact(t("clawsEffectReview.queryNames"), proposed.queryParameterNames.join(", ")) : nothing}
    ${proposed ? fact(t("clawsEffectReview.authentication"), proposed.authentication) : nothing}
    ${proposed?.environment?.length ? fact(t("clawsEffectReview.environment"), proposed.environment.map((entry) => `${entry.name} <- ${entry.sourceName}`).join(", ")) : nothing}
    ${proposed?.toolFilter?.include?.length ? fact(t("clawsEffectReview.includedTools"), proposed.toolFilter.include.join(", ")) : nothing}
    ${proposed?.toolFilter?.exclude?.length ? fact(t("clawsEffectReview.excludedTools"), proposed.toolFilter.exclude.join(", ")) : nothing}
    ${proposed ? fact(t("clawsEffectReview.timeout"), proposed.timeout) : nothing}
    ${proposed ? fact(t("clawsEffectReview.connectTimeout"), proposed.connectTimeout) : nothing}
    ${effect.ownership ? ownership(effect.ownership) : nothing}
  </dl>`;
}
