import type { JSX } from "@solidjs/web";
import { For, Show } from "solid-js";
import { Icon } from "../../components/solid/icon.tsx";
import { t } from "../../lib/reactive/i18n.ts";
import { MiddleTruncated, splitTail } from "../plugins/middle-truncated.tsx";

/** A skill's own mark: its image, else its emoji, else the default skill icon. */
export function SkillTile(props: {
  emoji?: string;
  imageUrl?: string;
  class?: JSX.HTMLAttributes<HTMLElement>["class"];
}) {
  return (
    <span
      class={[
        "skill-tile",
        props.class,
        { "skill-tile--default": !props.imageUrl && !props.emoji },
      ]}
      aria-hidden="true"
    >
      <Show
        when={props.imageUrl}
        fallback={
          <Show when={props.emoji} fallback={<Icon name="bookOpenText" />}>
            {props.emoji}
          </Show>
        }
      >
        {(url) => <img src={url()} alt="" loading="lazy" />}
      </Show>
    </span>
  );
}

/** A section of the reading column: a small muted label over its content. */
export function SkillPageSection(props: { title: JSX.Element; children: JSX.Element }) {
  return (
    <section class="skill-page__section">
      <h3 class="skill-page__label">{props.title}</h3>
      {props.children}
    </section>
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
