import type { JSX } from "@solidjs/web";
import { Show } from "solid-js";
import { subtitleForRoute, titleForRoute, type NavigationRouteId } from "../../app-navigation.ts";
import { ShellLayoutBoundary } from "../../app/shell-layout-traits-solid.tsx";
import { t } from "../../lib/reactive/i18n.ts";
import { HubTabs } from "./hub-tabs.tsx";
import { LearnMoreLink } from "./settings-ui.tsx";

export type HubPageHeaderTabs<T extends NavigationRouteId> = {
  id: string;
  items: readonly { value: T; label: JSX.Element }[];
  ariaLabel: string;
  panelId: string;
  class?: string;
  onSelect: (tab: T) => void;
};

/** Shared header for built-in pages: route title, subtitle, docs link, optional route tabs and actions. */
export type HubPageHeaderProps<T extends NavigationRouteId> = {
  active: T;
  /** Replaces the route title or subtitle when page state changes the heading, such as a filter. */
  title?: JSX.Element;
  subtitle?: JSX.Element;
  docsUrl?: string;
  tabs?: HubPageHeaderTabs<T>;
  /** Span the full content column for pages whose body is not width-capped. */
  wide?: boolean;
  class?: string;
  actions?: JSX.Element;
};

export function HubPageHeader<T extends NavigationRouteId>(props: HubPageHeaderProps<T>) {
  return (
    <ShellLayoutBoundary traits={{ hubHeader: true }}>
      <section
        class={[
          "content-header content-header--stacked content-header--settings content-header--page hub-page-header hub-page-header--stacked",
          { "hub-page-header--untabbed": !props.tabs, "hub-page-header--wide": props.wide },
          props.class,
        ]}
      >
        <div class="hub-page-header__title">
          <h1 class="page-title">{props.title ?? titleForRoute(props.active, t)}</h1>
          <div class="page-subtitle">
            {props.subtitle ?? subtitleForRoute(props.active, t)}
            <Show when={props.docsUrl}>
              {(url) => (
                <>
                  {" "}
                  <LearnMoreLink url={url()} />
                </>
              )}
            </Show>
          </div>
        </div>
        <Show when={props.tabs}>
          {(tabs) => (
            <div class="hub-page-header__tabs">
              <HubTabs<T>
                id={tabs().id}
                active={props.active}
                tabs={tabs().items}
                ariaLabel={tabs().ariaLabel}
                panelId={tabs().panelId}
                class={tabs().class}
                onSelect={(tab) => tabs().onSelect(tab)}
              />
            </div>
          )}
        </Show>
        <div class="hub-page-header__actions">{props.actions}</div>
      </section>
    </ShellLayoutBoundary>
  );
}
