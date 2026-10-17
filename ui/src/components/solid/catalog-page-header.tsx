import type { JSX } from "@solidjs/web";
import { children } from "solid-js";
import { ShellLayoutBoundary } from "../../app/shell-layout-traits-solid.tsx";
import "../../styles/hub-tabs.css";

export function CatalogPageHeader(props: {
  title: string;
  subtitle?: JSX.Element;
  tabs?: JSX.Element;
  actions?: JSX.Element;
  class?: string;
}) {
  const subtitle = children(() => props.subtitle);
  const tabs = children(() => props.tabs);
  const actions = children(() => props.actions);
  return (
    <ShellLayoutBoundary traits={{ hubHeader: true }}>
      <section
        class={[
          "content-header content-header--stacked content-header--settings content-header--page hub-page-header hub-page-header--stacked catalog-page-header",
          props.class,
          { "catalog-page-header--tabs": Boolean(tabs()) },
        ]}
      >
        <div class="hub-page-header__title">
          <h1 class="page-title">{props.title}</h1>
          {subtitle() && <div class="page-subtitle">{subtitle()}</div>}
        </div>
        {tabs() && <div class="hub-page-header__tabs">{tabs()}</div>}
        {actions() && <div class="hub-page-header__actions">{actions()}</div>}
      </section>
    </ShellLayoutBoundary>
  );
}
