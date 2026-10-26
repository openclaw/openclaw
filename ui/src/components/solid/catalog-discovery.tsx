import type { JSX } from "@solidjs/web";
import { Icon } from "./icon.tsx";

/** Shared discovery controls for the Plugins and Claws catalogs. */
export function CatalogDiscoverySearch(props: { children: JSX.Element }): JSX.Element {
  return (
    <label class="plugin-catalog-search">
      <span aria-hidden="true">
        <Icon name="search" />
      </span>
      {props.children}
    </label>
  );
}

export function CatalogDiscoveryChips(props: {
  label: string;
  children: JSX.Element;
}): JSX.Element {
  return (
    <div class="plugin-catalog-chips" role="group" aria-label={props.label}>
      {props.children}
    </div>
  );
}

export function CatalogDiscoveryChip(props: {
  active: boolean;
  icon?: JSX.Element;
  onClick: () => void;
  children: JSX.Element;
}): JSX.Element {
  return (
    <button
      type="button"
      class={["plugin-catalog-chip", { "is-active": props.active }]}
      aria-pressed={props.active ? "true" : "false"}
      onClick={() => props.onClick()}
    >
      {props.icon ? <span aria-hidden="true">{props.icon}</span> : undefined}
      {props.children}
    </button>
  );
}

export function CatalogDiscoverySection(props: {
  id: string;
  title: string;
  viewAllLabel?: string;
  onViewAll?: () => void;
  children: JSX.Element;
}): JSX.Element {
  return (
    <section
      class={[
        "plugin-catalog-section",
        { "plugin-catalog-section--expandable": Boolean(props.onViewAll) },
      ]}
      data-catalog-section={props.id}
    >
      <header class="plugin-catalog-section__header">
        <h2>{props.title}</h2>
        {props.onViewAll ? (
          <button
            type="button"
            class="btn btn--sm plugin-catalog-section__view-all oc-action oc-action-ghost"
            onClick={() => props.onViewAll?.()}
          >
            {props.viewAllLabel}
          </button>
        ) : undefined}
      </header>
      {props.children}
    </section>
  );
}
