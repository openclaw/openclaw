import type { JSX } from "@solidjs/web";
import { createEffect, createMemo, onSettled } from "solid-js";
import { isPhoneLayout } from "../../app/mobile-nav-layout.ts";
import { reclaimHubTabFocus, rememberHubTabFocus } from "../hub-tabs-focus.ts";
import { Tabs } from "./tabs.tsx";
import "../../styles/hub-tabs.css";
import hubStyles from "../../styles/hub-tabs.css?inline";

export type HubTabsProps<T extends string> = {
  id: string;
  active: T | null;
  tabs: readonly {
    value: T;
    label: JSX.Element;
    badge?: JSX.Element;
    count?: number | null;
    disabled?: boolean;
    testId?: string;
  }[];
  ariaLabel: string;
  panelId: string;
  class?: string;
  carapace?: boolean;
  variant?: "primary" | "sub";
  onSelect: (value: T) => void;
  onActivate?: (element: HTMLElement) => void;
};

/** Scrolls only the strip, so selecting a tab never moves the page around it. */
function revealInStrip(strip: HTMLElement, tab: HTMLElement | undefined) {
  if (!tab) {
    return;
  }
  const bounds = strip.getBoundingClientRect();
  const rect = tab.getBoundingClientRect();
  if (rect.left < bounds.left) {
    strip.scrollBy({ left: rect.left - bounds.left, behavior: "instant" });
  } else if (rect.right > bounds.right) {
    strip.scrollBy({ left: rect.right - bounds.right, behavior: "instant" });
  }
}

export function HubTabs<T extends string>(props: HubTabsProps<T>) {
  const items = createMemo(() =>
    props.tabs.map((tab) => ({
      value: tab.value,
      id: `${props.id}-tab-${tab.value}`,
      panelId: props.panelId,
      disabled: tab.disabled,
      testId: tab.testId,
      className: ["hub-tab", { "oc-segmented-item": props.carapace }],
      label: (
        <>
          {tab.label}
          {tab.count == null ? null : (
            <span class="hub-tab__badge hub-tab__badge--count">{tab.count}</span>
          )}
          {tab.badge == null ? null : <span class="hub-tab__badge">{tab.badge}</span>}
        </>
      ),
    })),
  );
  let strip!: HTMLElement;
  let tabElement!: (value: string) => HTMLElement | undefined;
  onSettled(() => {
    if (props.active !== null) {
      reclaimHubTabFocus(props.id, props.active, tabElement(props.active));
    }
  });
  // Count badges arrive after mount and can push the active tab back out of view.
  createEffect(
    () => ({ active: props.active, counts: props.tabs.map((tab) => tab.count).join() }),
    ({ active }) => {
      if (active !== null && isPhoneLayout()) {
        queueMicrotask(() => revealInStrip(strip, tabElement(active)));
      }
    },
  );
  return (
    <Tabs
      ref={(element, findTab) => {
        strip = element;
        tabElement = findTab;
      }}
      id={`${props.id}-tabs`}
      shadowStyles={[hubStyles]}
      items={items()}
      active={props.active}
      activation="manual"
      ariaLabel={props.ariaLabel}
      class={[
        "hub-tabs",
        `hub-tabs--${props.variant ?? "primary"}`,
        `${props.id}-hub-tabs`,
        { "oc-segmented": props.carapace },
        props.class,
      ]}
      onActivate={(value, element, event) => {
        const tab = props.tabs.find((entry) => entry.value === value);
        if (!tab || tab.value === props.active) {
          return false;
        }
        if (event instanceof KeyboardEvent) {
          rememberHubTabFocus(props.id, tab.value, element);
        }
        props.onSelect(tab.value);
        props.onActivate?.(element);
        return false;
      }}
    />
  );
}
