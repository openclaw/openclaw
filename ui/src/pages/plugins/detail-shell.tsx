import type { JSX } from "@solidjs/web";
import { Icon } from "../../components/solid/icon.tsx";
import { registerPluginManagementEnglish } from "../../i18n/locales/en-plugin-management.ts";
import { shouldHandleNavigationClick } from "../../lib/navigation-click.ts";
import { t, registerEnglishCatalog } from "../../lib/reactive/i18n.ts";

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
        onClick={(event: MouseEvent) => {
          if (!shouldHandleNavigationClick(event)) {
            return;
          }
          event.preventDefault();
          props.onBack();
        }}
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

export function renderPluginDetailShell(props: {
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
  panel: JSX.Element;
}): JSX.Element {
  const titleId = () => `${props.id}-title`;
  return (
    <section
      class={["plugin-catalog-detail", { "plugin-catalog-detail--no-sidebar": !props.sidebar }]}
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
          <div class="plugin-catalog-detail__title-row">
            <h1 id={titleId()}>{props.name}</h1>
          </div>
          {props.identity}
          {props.summary ? (
            <p class="plugin-catalog-detail__summary">{props.summary}</p>
          ) : undefined}
          <div class="plugin-catalog-detail__actions">{props.titleAction ?? undefined}</div>
        </div>
      </div>
      <div class="plugin-catalog-detail__content">
        <div class="plugin-catalog-detail__main">
          <section class="plugin-catalog-detail__panel">{props.panel}</section>
          {props.readme ? (
            <section class="plugin-catalog-detail__readme-section">
              <h2>{t("pluginsPage.detailTabs.readme")}</h2>
              {props.readme}
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
