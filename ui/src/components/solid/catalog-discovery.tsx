import type { JSX } from "@solidjs/web";
import { Icon } from "./icon.tsx";
import { useScrollState } from "./scroll-state.ts";

/** Shared discovery controls for the Plugins and Templates catalogs. */
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
  const scrollState = useScrollState(true);
  return (
    <div class="plugin-catalog-chips" role="group" aria-label={props.label} ref={scrollState}>
      {props.children}
    </div>
  );
}

export function CatalogDiscoveryChip(props: {
  ref?: (button: HTMLButtonElement) => void;
  active: boolean;
  icon?: JSX.Element;
  onClick: () => void;
  children: JSX.Element;
}): JSX.Element {
  return (
    <button
      type="button"
      ref={(button) => props.ref?.(button)}
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
  /** Lays the section out immediately rather than behind the remembered shelf height. */
  eager?: boolean;
  children: JSX.Element;
}): JSX.Element {
  return (
    <section
      class={[
        "plugin-catalog-section",
        { "plugin-catalog-section--expandable": Boolean(props.onViewAll) },
      ]}
      style={{ "content-visibility": props.eager ? "visible" : undefined }}
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
