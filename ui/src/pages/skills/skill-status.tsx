import { createMemo, Show } from "solid-js";
import type { SkillStatusEntry } from "../../api/types.ts";
import { registerSkillsBrowserEnglish } from "../../i18n/locales/en-skills-browser.ts";
import { t } from "../../lib/reactive/i18n.ts";
import {
  computeSkillMissing,
  computeSkillReasons,
  isSkillAvailable,
} from "../../lib/skills-shared.ts";
import { clawhubVerdictKey, type ClawHubSkillSecurityVerdict } from "../../lib/skills/index.ts";

registerSkillsBrowserEnglish();

export function SkillStatusChips(props: { skill: SkillStatusEntry; showBundledBadge?: boolean }) {
  return (
    <div class="chip-row" style={{ "margin-top": "6px" }}>
      <span class="chip">{props.skill.source}</span>
      <Show when={props.showBundledBadge}>
        <span class="chip">{t("skillStatus.bundled")}</span>
      </Show>
      <span class={["chip", isSkillAvailable(props.skill) ? "chip-ok" : "chip-warn"]}>
        {t(isSkillAvailable(props.skill) ? "skillStatus.eligible" : "skillStatus.blocked")}
      </span>
      <Show when={props.skill.disabled}>
        <span class="chip chip-warn">{t("skillStatus.disabled")}</span>
      </Show>
    </div>
  );
}

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

export function SkillStateStatus(props: {
  skill: SkillStatusEntry | { disabled: boolean };
  verdict?: ClawHubSkillSecurityVerdict | null;
}) {
  const status = createMemo(() => {
    const skill = props.skill;
    const verdict = props.verdict;
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
    return {
      tone,
      tooltip: [label, invalid, ...(flagged ? (verdict.reasons ?? []) : []), ...details]
        .filter(Boolean)
        .join(" · "),
    };
  });
  return (
    <span
      class={["plugin-catalog-card__status settings-status", `settings-status--${status().tone}`]}
      role="img"
      tabindex="0"
      aria-label={status().tooltip}
      title={status().tooltip}
    >
      <span class="settings-status__dot" aria-hidden="true" />
    </span>
  );
}

export function verdictStatus(
  verdict: ClawHubSkillSecurityVerdict | null | undefined,
  loading: boolean,
): { label: string; kind: "ok" | "warn" | "muted"; chipClass: string } {
  if (!verdict) {
    return loading
      ? { label: t("skillsPage.refreshing"), kind: "muted", chipClass: "chip" }
      : { label: t("skillsPage.verdict.unavailable"), kind: "warn", chipClass: "chip-warn" };
  }
  const status = verdict.securityStatus?.trim() || null;
  if (verdict.ok && verdict.decision === "pass") {
    return {
      label: status === "clean" || !status ? t("skillsPage.verdict.clean") : status,
      kind: "ok",
      chipClass: "chip-ok",
    };
  }
  if (status === "pending" || status === "not-run") {
    return { label: t("skillsPage.verdict.pending"), kind: "muted", chipClass: "chip" };
  }
  const label =
    status === "malicious"
      ? t("skillsPage.verdict.blocked")
      : status === "suspicious"
        ? t("skillsPage.verdict.review")
        : t("skillsPage.verdict.unavailable");
  return { label, kind: "warn", chipClass: "chip-warn" };
}
