import type { JSX } from "@solidjs/web";
import { For } from "solid-js";
import { titleForRoute } from "../app-navigation.ts";
import { pathForRoute } from "../app-route-paths.ts";
import { registerPortalsEnglish } from "../i18n/locales/en-portals.ts";
import { handleNavigationClick } from "../lib/navigation-click.ts";
import { portalsSidebarSource } from "../lib/portals-sidebar-source.ts";
import { registerEnglishCatalog, t } from "../lib/reactive/i18n.ts";
import type { AppSidebarRenderHost } from "./app-sidebar-render.tsx";

registerEnglishCatalog(registerPortalsEnglish);

/** The Portals section: one row per portal the open Portals page lists, its title over its port. */
export function SidebarPortals(props: { host: AppSidebarRenderHost }): JSX.Element {
  const source = () => portalsSidebarSource();
  const search = (portalId: string) => `?portal=${encodeURIComponent(portalId)}`;
  return (
    <nav class="sidebar-portals" aria-label={titleForRoute("portals", t)}>
      <For each={source()?.portals() ?? []} keyed={(portal) => portal.id}>
        {(portal) => {
          const current = () =>
            props.host.activeRouteId === "portals" && source()?.openPortalId() === portal().id;
          return (
            <a
              class={["nav-item sidebar-portals__row", { "nav-item--active": current() }]}
              href={`${pathForRoute("portals", props.host.basePath)}${search(portal().id)}`}
              aria-current={current() ? "page" : undefined}
              onClick={(event) =>
                handleNavigationClick(event, () => {
                  source()?.open(portal().id);
                  props.host.onNavigate?.("portals", { search: search(portal().id) });
                })
              }
            >
              <span class="sidebar-portals__copy">
                <span class="sidebar-portals__name">{portal().title}</span>
                <span class="sidebar-portals__byline">
                  {t("portalsPage.portLabel", { port: String(portal().port) })}
                </span>
              </span>
            </a>
          );
        }}
      </For>
    </nav>
  );
}
