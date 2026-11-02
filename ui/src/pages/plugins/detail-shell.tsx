import type { JSX } from "@solidjs/web";
import { ShellPageTitle } from "../../app/shell-page-title.tsx";
import { Icon } from "../../components/solid/icon.tsx";
import { SettingsGroup, SettingsPageHeader } from "../../components/solid/settings-ui.tsx";
import { registerPluginManagementEnglish } from "../../i18n/locales/en-plugin-management.ts";
import { handleNavigationClick } from "../../lib/navigation-click.ts";
import { t, registerEnglishCatalog } from "../../lib/reactive/i18n.ts";

registerEnglishCatalog(registerPluginManagementEnglish);

export function renderPluginDetailBack(props: {
  backHref: string;
  backLabel: string;
  onBack: () => void;
}): JSX.Element {
  return (
    <a
      class="plugin-catalog-detail__back"
      href={props.backHref}
      onClick={(event: MouseEvent) => handleNavigationClick(event, () => props.onBack())}
    >
      <Icon name="chevronLeft" />
      <span>{props.backLabel}</span>
    </a>
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
  /** Sits in the page header, where every settings page keeps its actions. */
  headerAction?: JSX.Element;
  /** Replaces the identity row once the plugin has a lifecycle to manage. */
  lifecycle?: JSX.Element;
  titleAction?: JSX.Element;
  identity?: JSX.Element;
  icon?: JSX.Element;
  readme?: JSX.Element;
  details?: JSX.Element;
  panel: JSX.Element;
}): JSX.Element {
  const titleId = () => `${props.id}-title`;
  return (
    <section class="plugin-catalog-detail" aria-labelledby={titleId()}>
      <ShellPageTitle title={props.name} />
      {renderPluginDetailBack(props)}
      <SettingsPageHeader
        stacked
        registerHeading={props.registerRemovalHeading}
        title={<span id={titleId()}>{props.name}</span>}
        subtitle={props.summary}
        actions={props.headerAction}
      />
      <div class="plugin-catalog-detail__hero">
        {props.lifecycle ?? (
          <SettingsGroup carapace>
            <div class="settings-row oc-settings-row">
              {props.icon ? (
                <div class="plugin-catalog-detail__icon" aria-hidden="true">
                  {props.icon}
                </div>
              ) : undefined}
              <div class="settings-row__text oc-settings-row-content">{props.identity}</div>
              <div class="settings-row__control oc-settings-row-control plugin-catalog-detail__actions">
                {props.titleAction}
              </div>
            </div>
          </SettingsGroup>
        )}
      </div>
      <section class="plugin-catalog-detail__panel">{props.panel}</section>
      {props.details ? (
        <div class="plugin-catalog-detail__details">{props.details}</div>
      ) : undefined}
      {props.readme ? (
        <section class="plugin-catalog-detail__readme-section">
          <h2 class="settings-section__heading oc-settings-section-title">
            {t("pluginsPage.detailTabs.readme")}
          </h2>
          {props.readme}
        </section>
      ) : undefined}
    </section>
  );
}
