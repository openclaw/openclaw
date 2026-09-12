import { html } from "lit";
import type { SkillStatusEntry } from "../../api/types.ts";
import { t } from "../../i18n/index.ts";
import {
  computeSkillMissing,
  computeSkillReasons,
  isSkillAvailable,
} from "../../lib/skills-shared.ts";
import { clawhubVerdictKey, type ClawHubSkillSecurityVerdict } from "../../lib/skills/index.ts";

export function verdictForSkill(
  skill: SkillStatusEntry,
  verdicts: Record<string, ClawHubSkillSecurityVerdict>,
) {
  const link = skill.clawhub;
  if (!link?.valid) {
    return null;
  }
  return (
    verdicts[
      clawhubVerdictKey({
        registry: link.registry,
        slug: link.slug,
        ownerHandle: link.ownerHandle,
        version: link.installedVersion,
      })
    ] ?? null
  );
}

export function renderSkillStateStatus(
  skill: SkillStatusEntry | { disabled: boolean },
  verdict?: ClawHubSkillSecurityVerdict | null,
) {
  const invalid =
    "clawhub" in skill && skill.clawhub?.status === "invalid" ? skill.clawhub.reason : null;
  const available = "eligible" in skill ? isSkillAvailable(skill) : !skill.disabled;
  const flagged = verdict && (!verdict.ok || verdict.decision !== "pass");
  const blocked = flagged && verdict.securityStatus === "malicious";
  const tone =
    invalid || blocked
      ? "danger"
      : flagged
        ? "warn"
        : skill.disabled
          ? "muted"
          : available
            ? "ok"
            : "warn";
  const label = flagged
    ? t(blocked ? "skillsPage.verdict.blocked" : "skillsPage.verdict.review")
    : invalid
      ? t("skillsPage.invalidLink")
      : t(
          skill.disabled
            ? "skillsPage.tabs.disabled"
            : available
              ? "eligible" in skill
                ? "skillsPage.tabs.ready"
                : "skillsPage.enabled"
              : "skillsPage.tabs.needsSetup",
        );
  const details =
    "missing" in skill
      ? [...computeSkillReasons(skill), ...computeSkillMissing(skill)]
      : [t("skillDiscovery.libraryStatus")];
  const tooltip = [label, invalid, ...(flagged ? (verdict.reasons ?? []) : []), ...details]
    .filter(Boolean)
    .join(" · ");
  return html`<span
    class="plugin-catalog-card__status settings-status settings-status--${tone}"
    role="img"
    tabindex="0"
    aria-label=${tooltip}
    title=${tooltip}
  >
    <span class="settings-status__dot" aria-hidden="true"></span>
  </span>`;
}
