import type { JSX } from "@solidjs/web";
import { subtitleForRoute, titleForRoute, type NavigationRouteId } from "../../app-navigation.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { CatalogPageHeader } from "./catalog-page-header.tsx";
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
    <CatalogPageHeader
      class={props.class}
      title={titleForRoute(props.active, t)}
      subtitle={
        <>
          {subtitleForRoute(props.active, t)} <LearnMoreLink url={props.docsUrl} />
        </>
      }
      tabs={
        <HubTabs<T>
          id={props.id}
          active={props.active}
          tabs={props.tabs}
          ariaLabel={props.ariaLabel}
          panelId={props.panelId}
          class={props.tabsClass}
          onSelect={props.onSelect}
        />
      }
      actions={props.actions}
    />
  );
}
