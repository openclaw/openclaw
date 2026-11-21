import type { JSX } from "@solidjs/web";
import { createSignal, createUniqueId, onSettled } from "solid-js";
import { Icon } from "../../components/solid/icon.tsx";
import { registerPluginManagementEnglish } from "../../i18n/locales/en-plugin-management.ts";
import { handleNavigationClick } from "../../lib/navigation-click.ts";
import { t, registerEnglishCatalog } from "../../lib/reactive/i18n.ts";
import { createResizeObserver } from "../../lib/reactive/observers.ts";

registerEnglishCatalog(registerPluginManagementEnglish);

export function renderPluginDetailBreadcrumb(props: {
  name: string;
  backHref: string;
  backLabel: string;
  onBack: () => void;
}): JSX.Element {
  return (
    <nav class="plugins-settings-breadcrumb" aria-label={t("pluginsPage.breadcrumb")}>
      <a
        class="plugins-settings-breadcrumb__parent"
        href={props.backHref}
        onClick={(event: MouseEvent) => handleNavigationClick(event, () => props.onBack())}
      >
        {props.backLabel}
      </a>
      <span class="plugins-settings-breadcrumb__chevron" aria-hidden="true">
        {<Icon name="chevronRight" />}
      </span>
      <span class="plugins-settings-breadcrumb__current" aria-current="page">
        {props.name}
      </span>
    </nav>
  );
}

/**
 * Plugin and skill pages clamp a long README inside its surface, with the chat message's Show
 * more toggle. `expanded` sets how it first shows; the toggle then owns it.
 */
export function PluginReadmeWell(props: {
  children: JSX.Element;
  expanded?: boolean;
  /** The toggle stays available when opening loads a separate full document. */
  alwaysExpandable?: boolean;
  /** Called after the reader opens or closes the whole text. */
  onToggle?: (expanded: boolean) => void;
}): JSX.Element {
  let body!: HTMLDivElement;
  let well!: HTMLDivElement;
  const [toggled, setExpanded] = createSignal<boolean>();
  const expanded = () => toggled() ?? Boolean(props.expanded);
  const [overflows, setOverflows] = createSignal(false);
  const bodyId = `plugin-readme-${createUniqueId()}`;
  createResizeObserver(
    () => [body],
    () => {
      const limit = Number.parseFloat(
        getComputedStyle(well).getPropertyValue("--plugin-readme-clamp"),
      );
      setOverflows(body.scrollHeight > limit + 24);
    },
  );
  return (
    <div
      ref={(element) => (well = element)}
      class={["plugin-catalog-detail__readme-well", { "is-clamped": overflows() && !expanded() }]}
    >
      <div
        id={bodyId}
        ref={(element) => (body = element)}
        class="plugin-catalog-detail__readme-body"
      >
        {props.children}
      </div>
      <button
        type="button"
        class="plugin-catalog-detail__readme-toggle"
        hidden={!expanded() && !overflows() && !props.alwaysExpandable}
        aria-expanded={expanded() ? "true" : "false"}
        aria-controls={bodyId}
        onClick={() => {
          const next = !expanded();
          setExpanded(next);
          props.onToggle?.(next);
        }}
      >
        {t(expanded() ? "chat.messages.showLess" : "chat.messages.showMore")}
        <Icon name={expanded() ? "chevronUp" : "chevronDown"} />
      </button>
    </div>
  );
}

export function renderPluginDetailShell(props: {
  registerRemovalHeading?: (heading: HTMLHeadingElement) => () => void;
  id: string;
  name: string;
  summary?: string;
  backHref: string;
  backLabel: string;
  onBack: () => void;
  titleAction?: JSX.Element;
  identity: JSX.Element | undefined;
  icon?: JSX.Element;
  readme?: JSX.Element;
  sidebar?: JSX.Element;
  recommendations?: JSX.Element;
  panel: JSX.Element;
  /** Status about the whole plugin (errors, pending reads); opens the reading column. */
  notices?: JSX.Element;
  /** Plugin pages: actions beside the name, the summary opens the reading column, facts in a rail. */
  rail?: boolean;
}): JSX.Element {
  let heading!: HTMLHeadingElement;
  onSettled(() => props.registerRemovalHeading?.(heading));
  const titleId = () => `${props.id}-title`;
  const summary = () =>
    props.summary ? <p class="plugin-catalog-detail__summary">{props.summary}</p> : undefined;
  const actions = () => (
    <div class="plugin-catalog-detail__actions">{props.titleAction ?? undefined}</div>
  );
  return (
    <section
      class={[
        "plugin-catalog-detail",
        {
          "plugin-catalog-detail--no-sidebar": !props.sidebar,
          "plugin-catalog-detail--rail": props.rail,
        },
      ]}
      aria-labelledby={titleId()}
    >
      {renderPluginDetailBreadcrumb(props)}
      <div class="plugin-catalog-detail__hero">
        {props.icon ? (
          <div class="plugin-catalog-detail__icon" aria-hidden="true">
            {props.icon}
          </div>
        ) : undefined}
        <div class="plugin-catalog-detail__heading">
          <div class="plugin-catalog-detail__name">
            <div class="plugin-catalog-detail__title-row">
              <h1 id={titleId()} ref={(element) => (heading = element)}>
                {props.name}
              </h1>
            </div>
            {props.identity}
          </div>
          {props.rail ? undefined : summary()}
          {props.rail ? undefined : actions()}
        </div>
        {props.rail ? actions() : undefined}
      </div>
      <div class="plugin-catalog-detail__content">
        <div class="plugin-catalog-detail__main">
          {props.notices ? (
            <div class="plugin-catalog-detail__notices">{props.notices}</div>
          ) : undefined}
          {props.rail ? summary() : undefined}
          {props.recommendations}
          <section class="plugin-catalog-detail__panel">{props.panel}</section>
          {props.readme ? (
            <section class="plugin-catalog-detail__readme-section">
              <h2 class="settings-section__heading oc-settings-section-title">
                {t("pluginsPage.detailTabs.readme")}
              </h2>
              {props.rail ? <PluginReadmeWell>{props.readme}</PluginReadmeWell> : props.readme}
            </section>
          ) : undefined}
        </div>
        {props.sidebar ? (
          <aside class="plugin-catalog-detail__sidebar">{props.sidebar}</aside>
        ) : undefined}
      </div>
    </section>
  );
}
