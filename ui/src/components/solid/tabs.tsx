import type { JSX } from "@solidjs/web";
import { For, createEffect, untrack } from "solid-js";
import { createTabList, type TabsOptions } from "../../lib/tabs.ts";
import { bindShadowStyles } from "./shadow-styles.ts";
import tabsStyles from "../../styles/tabs.css?inline";
import "../../styles/tabs.css";

type TabOption = {
  value: string;
  label: JSX.Element;
  id?: string;
  panelId?: string;
  disabled?: boolean;
  className?: JSX.HTMLAttributes<HTMLButtonElement>["class"];
  testId?: string;
  attributes?: JSX.HTMLAttributes<HTMLButtonElement> & {
    [name: `data-${string}`]: string | number | boolean | undefined;
  };
};

export type TabsProps = TabsOptions & {
  id?: string;
  items: readonly TabOption[];
  ariaLabel: string;
  class?: JSX.HTMLAttributes<HTMLDivElement>["class"];
  ref?: (element: HTMLDivElement, tab: (value: string) => HTMLElement | undefined) => void;
  shadowStyles?: readonly string[];
};

export function Tabs(props: TabsProps) {
  let element!: HTMLDivElement;
  const tabs = createTabList(
    () => props,
    () =>
      props.items.map((item) => ({
        value: item.value,
        disabled: item.disabled || item.attributes?.["aria-disabled"] === "true",
      })),
    () => element,
  );
  // A hosted tablist must install its styles in the actual shadow root.
  createEffect(
    () => [props.shadowStyles, props.items, props.active, props.defaultActive] as const,
    ([extra]) => {
      const styles = bindShadowStyles(element, [tabsStyles, ...(extra ?? [])]);
      return () => styles.dispose();
    },
  );
  return (
    <div
      ref={(node) => {
        element = node;
        props.ref?.(node, tabs.element);
      }}
      id={props.id}
      class={["oc-tabs", props.class]}
      role="tablist"
      aria-label={props.ariaLabel}
      aria-orientation={props.orientation ?? "horizontal"}
    >
      <For each={props.items} keyed={(item) => item.value}>
        {(item) => {
          // The keyed value is this node's lifetime identity.
          const ref = tabs.ref(untrack(() => item().value));
          return (
            <button
              {...item().attributes}
              ref={ref}
              type="button"
              role="tab"
              class={["oc-tab", item().className]}
              id={item().id}
              data-tab-value={item().value}
              data-test-id={item().testId}
              aria-controls={item().panelId}
              aria-selected={item().value === tabs.active() ? "true" : "false"}
              {...{ active: item().value === tabs.active() ? "" : undefined }}
              disabled={item().disabled}
              tabindex={tabs.tabIndex(item().value)}
              onClick={tabs.onClick}
              onKeyDown={tabs.onKeyDown}
            >
              {item().label}
            </button>
          );
        }}
      </For>
    </div>
  );
}

export function TabPanel(props: {
  id: string;
  tabId: string;
  active: boolean;
  children: JSX.Element;
  className?: string;
  tabIndex?: number;
}) {
  return (
    <div
      id={props.id}
      class={props.className}
      role="tabpanel"
      aria-labelledby={props.tabId}
      hidden={!props.active}
      tabindex={props.tabIndex ?? 0}
    >
      {props.children}
    </div>
  );
}
