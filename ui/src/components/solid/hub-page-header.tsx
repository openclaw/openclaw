import type { JSX } from "@solidjs/web";
import { subtitleForRoute, titleForRoute, type NavigationRouteId } from "../../app-navigation.ts";
import { ShellLayoutBoundary } from "../../app/shell-layout-traits-solid.tsx";
import { t } from "../../lib/reactive/i18n.ts";
import { HubTabs } from "./hub-tabs.tsx";
import { LearnMoreLink } from "./settings-ui.tsx";

export type HubPageHeaderProps<T extends NavigationRouteId> = {
  id: string;
  active: T;
  tabs: readonly { value: T; label: JSX.Element }[];
  ariaLabel: string;
  panelId: string;
  docsUrl: string;
  class?: string;
  tabsClass?: string;
  actions?: JSX.Element;
  onSelect: (tab: T) => void;
};

export function HubPageHeader<T extends NavigationRouteId>(props: HubPageHeaderProps<T>) {
  return (
    <ShellLayoutBoundary traits={{ hubHeader: true }}>
      <section
        class={[
          "content-header content-header--stacked content-header--settings content-header--page hub-page-header hub-page-header--stacked",
          props.class,
        ]}
      >
        <div class="hub-page-header__title">
          <h1 class="page-title">{titleForRoute(props.active, t)}</h1>
          <div class="page-subtitle">
            {subtitleForRoute(props.active, t)} <LearnMoreLink url={props.docsUrl} />
          </div>
        </div>
        <div class="hub-page-header__tabs">
          <HubTabs<T>
            id={props.id}
            active={props.active}
            tabs={props.tabs}
            ariaLabel={props.ariaLabel}
            panelId={props.panelId}
            class={props.tabsClass}
            onSelect={props.onSelect}
          />
        </div>
        <div class="hub-page-header__actions">{props.actions}</div>
      </section>
    </ShellLayoutBoundary>
  );
}
