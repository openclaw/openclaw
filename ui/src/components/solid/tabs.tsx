import type { JSX } from "@solidjs/web";
import { For, createEffect, onCleanup, onSettled } from "solid-js";
import { createTabsController, type TabsOptions } from "../../lib/tabs-controller.ts";
import { bindShadowStyles } from "./shadow-styles.ts";
import tabsStyles from "../../styles/tabs.css?inline";
import "../../styles/tabs.css";

export type TabOption = {
  value: string;
  label: JSX.Element;
  id?: string;
  panelId?: string;
  disabled?: boolean;
  className?: string;
  testId?: string;
};

export type TabsProps = TabsOptions & {
  id?: string;
  items: readonly TabOption[];
  ariaLabel: string;
  class?: JSX.HTMLAttributes<HTMLDivElement>["class"];
  ref?: (element: HTMLDivElement) => void;
  shadowStyles?: readonly string[];
};

export function Tabs(props: TabsProps) {
  let element!: HTMLDivElement;
  let controller: ReturnType<typeof createTabsController> | undefined;
  let options: TabsOptions = {};
  let styles: ReturnType<typeof bindShadowStyles> | undefined;
  let styleTexts: readonly string[] = [];
  createEffect(
    () => ({
      active: props.active,
      defaultActive: props.defaultActive,
      orientation: props.orientation,
      activation: props.activation,
      onSelect: props.onSelect,
      onActivate: props.onActivate,
      items: props.items,
      shadowStyles: props.shadowStyles,
    }),
    (snapshot) => {
      options = snapshot;
      const nextStyles = [tabsStyles, ...(snapshot.shadowStyles ?? [])];
      if (
        nextStyles.length !== styleTexts.length ||
        nextStyles.some((css, index) => css !== styleTexts[index])
      ) {
        styleTexts = nextStyles;
        styles?.dispose();
        styles = undefined;
      }
      if (controller) {
        styles ??= bindShadowStyles(element, styleTexts);
        styles.sync();
        controller.sync();
      }
    },
  );
  onSettled(() => {
    controller = createTabsController(element, () => options);
    styles = bindShadowStyles(element, styleTexts);
  });
  onCleanup(() => {
    controller?.dispose();
    styles?.dispose();
  });
  return (
    <div
      ref={(node) => {
        element = node;
        props.ref?.(node);
      }}
      id={props.id}
      class={["oc-tabs", props.class]}
      role="tablist"
      aria-label={props.ariaLabel}
      aria-orientation={props.orientation ?? "horizontal"}
    >
      <For each={props.items} keyed={(item) => item.value}>
        {(item) => (
          <button
            type="button"
            role="tab"
            class={["oc-tab", item().className]}
            id={item().id}
            data-tab-value={item().value}
            data-test-id={item().testId}
            aria-controls={item().panelId}
            aria-selected={
              item().value === (props.active === undefined ? props.defaultActive : props.active)
                ? "true"
                : "false"
            }
            disabled={item().disabled}
            tabindex={
              item().value === (props.active === undefined ? props.defaultActive : props.active)
                ? 0
                : -1
            }
          >
            {item().label}
          </button>
        )}
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
