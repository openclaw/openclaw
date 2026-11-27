import type { JSX } from "@solidjs/web";
import { For, Show } from "solid-js";
import type { SkillStatusEntry } from "../../api/types.ts";
import { Icon } from "../../components/solid/icon.tsx";
import { Switch } from "../../components/solid/switch.tsx";
import { t } from "../../lib/reactive/i18n.ts";
import { MiddleTruncated, splitTail } from "../plugins/middle-truncated.tsx";
import type { SkillsProps } from "./view-types.ts";

/** A section of the reading column, labelled like the plugin page's README. */
export function SkillPageSection(props: { title: JSX.Element; children: JSX.Element }) {
  return (
    <section class="plugin-catalog-detail__readme-section skill-page__section">
      <h2 class="settings-section__heading oc-settings-section-title">{props.title}</h2>
      {props.children}
    </section>
  );
}

/** An installed skill's switch, the same wherever the skill's page shows it. */
export function SkillEnabledSwitch(props: { skill: SkillStatusEntry; view: SkillsProps }) {
  const saving = () => props.view.toggleSavingSkillKey === props.skill.skillKey;
  const locked = () =>
    props.view.saving || props.view.loading || props.view.state.skillOperation !== null;
  return (
    <label class="plugin-catalog-detail__enabled">
      <span aria-hidden="true">
        {t(props.skill.disabled ? "skillsPage.disabled" : "skillsPage.enabled")}
      </span>
      <Switch
        checked={!props.skill.disabled}
        saving={saving()}
        disabled={
          !props.view.canUpdate ||
          (props.view.toggleDisabled ?? props.view.loading) ||
          (!saving() && locked())
        }
        ariaLabel={props.skill.name}
        onChange={() => props.view.onToggle(props.skill.skillKey, props.skill.disabled)}
      />
    </label>
  );
}

export type SkillSecurityTone = "pass" | "warning" | "danger" | "unknown";

/** Security state as plain text with three bars, and the report as one quiet link beside it. */
export function SkillSecurityFact(props: {
  label: string;
  tone: SkillSecurityTone;
  auditHref?: string | null;
  note?: JSX.Element;
}) {
  const bars = () => ({ pass: 3, warning: 2, danger: 1, unknown: 0 })[props.tone];
  return (
    <div
      class={["plugin-catalog-detail__security", `plugin-catalog-detail__security--${props.tone}`]}
    >
      <dt>{t("skillsPage.securityCheck")}</dt>
      <dd>
        <span class="plugin-catalog-detail__security-score">
          <span class="plugin-catalog-detail__security-verdict">{props.label}</span>
          <span class="plugin-catalog-detail__security-bars" aria-hidden="true">
            <For each={[0, 1, 2]}>
              {(index) => <span class={{ "is-filled": index < bars() }} />}
            </For>
          </span>
        </span>
        <Show when={props.auditHref}>
          {(href) => (
            <a
              class="plugin-metadata__audit-link"
              href={href()}
              target="_blank"
              rel="noopener noreferrer"
              aria-label={t("skillsPage.fullSecurityReport")}
              title={t("skillsPage.fullSecurityReport")}
            >
              <span>{t("pluginsPage.detailSecurityAuditLink")}</span>
              <Icon name="arrowUpRight" />
            </a>
          )}
        </Show>
        <Show when={props.note}>
          <span class="skill-page__fact-note">{props.note}</span>
        </Show>
      </dd>
    </div>
  );
}

/** A long id or path on one line: the start gives way, the identifying end stays whole. */
export function SkillMonoFact(props: { value: string; segments?: number }) {
  // Keep the last folder with the file name only while that end stays short enough to show whole.
  const parts = () => {
    const wide = splitTail(props.value, props.segments);
    return wide.tail.length > 24 ? splitTail(props.value) : wide;
  };
  return (
    <span class="skill-page__mono">
      <MiddleTruncated {...parts()} />
    </span>
  );
}

/** A link that leaves the app, shown as its host and path with the leaving arrow. */
export function SkillLinkFact(props: { href: string }) {
  const text = () => {
    const url = new URL(props.href);
    return `${url.hostname}${url.pathname.replace(/\/$/u, "")}`;
  };
  return (
    <dd class="plugin-metadata__link-value">
      <a class="plugin-metadata__link" href={props.href} target="_blank" rel="noopener noreferrer">
        <MiddleTruncated {...splitTail(text())} />
        <Icon name="arrowUpRight" />
      </a>
    </dd>
  );
}
